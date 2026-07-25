const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');

const SUPPLIER_NAME = 'Julian Fashion Srl';
const SUPPLIER_SLUG = 'julian-fashion';

const LIMIT_PRODUCTS = Number(process.env.LIMIT_PRODUCTS || 50);
const START_PAGE = Number(process.env.START_PAGE || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 1);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);

const MAX_RUN_MINUTES = Number(process.env.MAX_RUN_MINUTES || 240);
const LOCK_NAME = 'delta:julian';
const LOCK_STALE_MINUTES = Number(process.env.LOCK_STALE_MINUTES || 360);
const LOCKED_BY = `${os.hostname()}:${process.pid}`;

// ✅ п.4/5: политика "одна плохая страница не роняет весь скан"
const POISON_PAGE_CONSECUTIVE_THRESHOLD = Number(process.env.POISON_PAGE_CONSECUTIVE_THRESHOLD || 2);
const POISON_PAGE_RATE_THRESHOLD = Number(process.env.POISON_PAGE_RATE_THRESHOLD || 0.05);
const POISON_PAGE_MIN_SAMPLE = Number(process.env.POISON_PAGE_MIN_SAMPLE || 20);
// ✅ п.6: батчи отправляются по ходу скана, не одним махом в конце
const FLUSH_EVERY_PAGES = Number(process.env.FLUSH_EVERY_PAGES || 10);

const LISTING_URL = process.env.JULIAN_LISTING_URL || 'https://b2bfashion.online/306-all';

// ✅ Новая ветка: скачивание полного CSV-экспорта вместо обхода страниц
// листинга — только для обновления цен/остатков УЖЕ известных товаров.
// Discovery новых SKU / found_on_page для WF07 — по-прежнему только через
// обычный постраничный путь (SOURCE_MODE='listing', дефолт, не меняется).
const SOURCE_MODE = process.env.SOURCE_MODE || 'listing';
const CSV_EXPORT_URL = process.env.JULIAN_CSV_EXPORT_URL || 'https://b2bfashion.online/module/bbapi/get_export';

function getSupabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is missing');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is missing');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function checkSupplierGate() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/supplier_gate_state?supplier_slug=eq.${SUPPLIER_SLUG}&select=status,cooldown_until`;
  const response = await axios.get(url, { headers: getSupabaseHeaders(), timeout: 15000 });
  const gate = response.data?.[0];
  const blocked = gate && gate.status === 'blocked' &&
    (!gate.cooldown_until || new Date(gate.cooldown_until) > new Date());
  return { blocked: Boolean(blocked), gate };
}

async function tryAcquireRunLock() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/try_acquire_workflow_lock`;
  const response = await axios.post(
    url,
    { p_workflow_name: LOCK_NAME, p_locked_by: LOCKED_BY, p_stale_minutes: LOCK_STALE_MINUTES },
    { headers: getSupabaseHeaders(), timeout: 15000 }
  );
  return response.data === true;
}

async function releaseRunLock() {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/release_workflow_lock`;
    await axios.post(url, { p_workflow_name: LOCK_NAME, p_locked_by: LOCKED_BY },
      { headers: getSupabaseHeaders(), timeout: 15000 });
  } catch (err) {
    console.error('[LOCK] release failed (non-fatal):', err.message);
  }
}

async function checkLockStillOwned() {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/workflow_locks?workflow_name=eq.${encodeURIComponent(LOCK_NAME)}&select=locked_by`;
    const response = await axios.get(url, { headers: getSupabaseHeaders(), timeout: 15000 });
    const row = response.data?.[0];
    return row && row.locked_by === LOCKED_BY;
  } catch (err) {
    console.error('[LOCK] ownership check failed:', err.message);
    console.log('[LOCK] ownership check failed — fail-open');
    return true;
  }
}

async function writeAbortSyncLog(status, startedAtIso, pagesScanned, itemsCollected) {
  try {
    await axios.post(
      `${process.env.SUPABASE_URL}/rest/v1/sync_logs`,
      {
        supplier_slug: SUPPLIER_SLUG,
        sync_type: 'delta',
        status,
        items_total: itemsCollected,
        error_message: `pages_scanned=${pagesScanned}, max_pages=${MAX_PAGES}, reason=${status}`,
        started_at: startedAtIso,
        finished_at: new Date().toISOString()
      },
      { headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' }, timeout: 15000 }
    );
  } catch (err) {
    console.error('[SYNC LOG] abort log insert failed (non-fatal):', err.message);
  }
}

// ─── UTILS ───────────────────────────────────────────────
 
function cleanText(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned || null;
}
 
function buildSlug(value) {
  if (!value) return 'unknown';
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/['\u2019\u2018]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}
 
function toNumber(value) {
  if (value === null || value === undefined) return null;
  let s = String(value)
    .replace(/\s/g, '')
    .replace('€', '')
    .replace('%', '')
    .replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
 
function sha256Hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
 
// ✅ FIX 9: единый алгоритм product_hash — pipe-строка от price/stock
// данных, идентичный алгоритму в ноде Split Products (WF1).
// Это единственный источник истины для product_hash во всей системе.
// scrape-julian-full.js НЕ пересчитывает и НЕ перезаписывает это поле —
// он работает с отдельным enrichment_hash.
function buildProductHash({
  supplierFinalPrice,
  supplierRetailPrice,
  supplierDiscountPercent,
  isActive,
  isArchived,
  totalStock
}) {
  const hashSource = [
    String(supplierFinalPrice ?? ''),
    String(supplierRetailPrice ?? ''),
    String(supplierDiscountPercent ?? ''),
    String(isActive ?? true),
    String(isArchived ?? false),
    String(totalStock)
  ].join('|');
 
  return {
    hash: sha256Hash(hashSource),
    hashSource
  };
}
 
function buildPageUrl(pageNumber) {
  return pageNumber > 1
    ? `${LISTING_URL}?page=${pageNumber}`
    : LISTING_URL;
}

// ── CSV EXPORT MODE ──────────────────────────────────────────
// Логика зеркалит lib/adapter-julian.js (не импортирую этот файл — он
// untracked/неиспользуемый локальный порт, см. reference-память проекта;
// переиспользую тот же алгоритм внутри уже боевого файла).

function stripSizePrefix(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^size:\s*/i, '').trim();
  return s || null;
}

function parseQty(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : 0;
}

function computeRowPricing(row) {
  const retailPrice = toNumber(row['retail price']);
  let discountedPrice = toNumber(row['discounted price']);
  // та же защита от аномалии "скидка >= розницы", что в lib/adapter-julian.js
  if (discountedPrice != null && retailPrice != null && discountedPrice >= retailPrice) {
    discountedPrice = null;
  }
  const finalPrice = discountedPrice ?? retailPrice;
  const discountPercent = (retailPrice && finalPrice != null && finalPrice < retailPrice)
    ? Math.round((1 - finalPrice / retailPrice) * 100)
    : null;
  return { retailPrice, finalPrice, discountPercent };
}

function buildProductFromCsvGroup(cod, rows) {
  const first = rows[0];

  const brand = cleanText(first.designer);
  const seasonRaw = cleanText(first.season);
  const isSale = String(seasonRaw || '').trim().toLowerCase() === 'sale';

  // Товарный уровень — из первой строки группы (обратная совместимость с
  // WF01/supplier_raw_products; это цена "первого варианта", не единая
  // цена товара — точность по размерам см. variants_raw ниже, часть
  // групп имеет разную цену на разные размеры одного cod).
  const { retailPrice, finalPrice, discountPercent } = computeRowPricing(first);

  const variantRows = rows
    .map(r => ({
      supplier_size: stripSizePrefix(r.size),
      stock_quantity: parseQty(r.qty),
      ...computeRowPricing(r)
    }))
    .filter(v => v.supplier_size);

  const variantsRaw = variantRows.length
    ? variantRows.map(v => ({
        supplier_size: v.supplier_size,
        supplier_sku: `${cod}-${v.supplier_size}`,
        supplier_variant_code: `${cod}-${v.supplier_size}`,
        stock_quantity: v.stock_quantity,
        is_available: v.stock_quantity > 0,
        supplier_retail_price: v.retailPrice,
        supplier_final_price: v.finalPrice,
        supplier_discount_percent: v.discountPercent,
        currency: 'EUR',
        raw_variant_json: v
      }))
    : [{
        supplier_size: 'U',
        supplier_sku: `${cod}-U`,
        supplier_variant_code: `${cod}-U`,
        stock_quantity: 1,
        is_available: true,
        supplier_retail_price: retailPrice,
        supplier_final_price: finalPrice,
        supplier_discount_percent: discountPercent,
        currency: 'EUR',
        raw_variant_json: { fallback: true, reason: 'No size rows in CSV group' }
      }];

  const totalStock = variantsRaw.reduce((sum, v) => sum + (Number(v.stock_quantity) || 0), 0);

  const { hash: productHash, hashSource } = buildProductHash({
    supplierFinalPrice: finalPrice,
    supplierRetailPrice: retailPrice,
    supplierDiscountPercent: discountPercent,
    isActive: true,
    isArchived: false,
    totalStock
  });

  const brandSlug = buildSlug(brand);
  const productKey = `${brandSlug}-${cod}-unknown`;

  const imagesRaw = [first.foto1, first.foto2, first['foto 3']]
    .map(url => (url ? String(url).trim() : null))
    .filter(url => url && url.startsWith('http'))
    .map((url, index) => ({
      url, image_url: url, supplier_image_url: url,
      position: index + 1, image_position: index + 1,
      type: index === 0 ? 'main' : 'gallery',
      image_type: index === 0 ? 'main' : 'gallery',
      is_main: index === 0
    }));

  const scannedAt = new Date().toISOString();

  return {
    supplier_name: SUPPLIER_NAME,
    supplier_slug: SUPPLIER_SLUG,
    supplier_sku: cod,
    supplier_product_code: cod,
    supplier_product_url: null,   // ✅ п.4: CSV не даёт URL карточки
    listing_url: null,            // ✅ п.4: не со страницы листинга
    found_on_page: null,          // ✅ п.4: CSV не даёт номер страницы

    brand_raw: brand,
    title_raw: null,
    description_raw: null,
    gender_raw: null,
    category_raw: null,
    subcategory_raw: null,
    type_raw: null,
    color_raw: null,
    season_raw: seasonRaw,
    composition_raw: null,
    made_in_raw: null,
    size_and_fit_raw: null,

    supplier_retail_price: retailPrice,
    supplier_final_price: finalPrice,
    supplier_discount_percent: discountPercent,
    currency: 'EUR',
    is_sale: isSale,

    product_key: productKey,
    product_hash: productHash,
    hash_source: hashSource,

    images_raw: imagesRaw,
    variants_raw: variantsRaw,

    raw_json: {
      source: 'csv_export_delta',
      cod,
      rows_in_group: rows.length
    },

    scrape_status: 'ingested',
    scan_mode: 'delta_csv',

    is_active: true,
    is_archived: false,

    scanned_at: scannedAt,
    ingested_at: scannedAt
  };
}

async function downloadAndParseCsvExport(page) {
  console.log('[CSV EXPORT] downloading:', CSV_EXPORT_URL);
  const response = await page.context().request.get(CSV_EXPORT_URL, { timeout: 120000 });
  if (!response.ok()) {
    throw new Error(`CSV export request failed: HTTP ${response.status()}`);
  }
  // ✅ latin-1, как и исходный bulk-load файл — .text()/utf8 испортил бы
  // акцентированные символы, поэтому декодируем сырой Buffer явно.
  const buffer = await response.body();
  const text = buffer.toString('latin1');

  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_quotes: true, bom: true });
  console.log('[CSV EXPORT] rows parsed:', rows.length);

  const grouped = new Map();
  for (const row of rows) {
    const cod = row.cod ? String(row.cod).trim() : '';
    if (!cod) continue;
    if (!grouped.has(cod)) grouped.set(cod, []);
    grouped.get(cod).push(row);
  }

  const products = [];
  for (const [cod, groupRows] of grouped) {
    products.push(buildProductFromCsvGroup(cod, groupRows));
  }
  console.log('[CSV EXPORT] unique products:', products.length);
  return products;
}

// ─── LOGIN ────────────────────────────────────────────────
 
async function login(page) {
  console.log('[LOGIN] Opening Julian login page...');
 
  if (!process.env.JULIAN_LOGIN_URL) throw new Error('JULIAN_LOGIN_URL is missing');
  if (!process.env.JULIAN_EMAIL || !process.env.JULIAN_PASSWORD) {
    throw new Error('JULIAN_EMAIL or JULIAN_PASSWORD is missing');
  }
 
  await page.goto(process.env.JULIAN_LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
 
  await page.waitForTimeout(3000);
  await page.fill('input[type="email"]', process.env.JULIAN_EMAIL);
  await page.fill('input[type="password"]', process.env.JULIAN_PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(12000);
 
  console.log('[LOGIN] Completed. URL:', page.url());
}
 
// ─── OPEN LISTING ─────────────────────────────────────────
 
async function openListing(page, pageNumber) {
  const pageUrl = buildPageUrl(pageNumber);
 
  console.log('========================');
  console.log('[DELTA] PAGE:', pageNumber, '| URL:', pageUrl);
  console.log('========================');
 
  await page.goto(pageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
 
  await page.waitForTimeout(8000);
 
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 3500);
    await page.waitForTimeout(700);
  }
 
  const count = await page.locator('.product-miniature').count();
  console.log('[DELTA] Products found on page:', count);
  return count;
}
 
// ─── COLLECT PRODUCTS ─────────────────────────────────────
 
async function collectProductsFromListing(page, pageNumber) {
  const products = [];
  let skipped = 0;
 
  const productCards = page.locator('.product-miniature');
  const count = await productCards.count();
  const limit = Math.min(count, LIMIT_PRODUCTS);
 
  console.log('[DELTA] Cards to collect:', limit);
 
  for (let i = 0; i < limit; i++) {
    const card = productCards.nth(i);
 
    const data = await card.evaluate(el => {
      const text = el.innerText || '';
 
      const lines = text
        .split('\n')
        .map(x => x.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
 
      const idProduct = el.getAttribute('data-id-product') || null;
      const productUrl =
        el.querySelector('a[href$=".html"]')?.href ||
        (idProduct
          ? `https://b2bfashion.online/index.php?controller=product&action=quickview&id_product=${idProduct}`
          : null);
 
      const imageUrls = Array.from(el.querySelectorAll('img'))
        .map(img =>
          img.getAttribute('data-full-size-image-url') ||
          img.getAttribute('src') ||
          img.getAttribute('data-src')
        )
        .filter(Boolean)
        .filter(url => !url.includes('data:image'))
        .map(url => url.replace(/\\/g, ''));
 
      const moneyMatches = text.match(/€\s?[\d.,]+/g) || [];
      const discountMatch = text.match(/-\s?\d+%/);
 
      const brand = lines[0] || null;
 
      const seasonLine =
        lines.find(line =>
          /Spring Summer|Fall Winter|Autumn Winter|SS\d|FW\d|^Sale$/i.test(line)
        ) || null;
 
      const productCodeLine = lines.find(line => {
        const normalized = line.trim();
        const brandLine = brand ? brand.trim().toUpperCase() : '';
        return (
          normalized.toUpperCase() !== brandLine &&
          /^[A-Z0-9\-]{5,}$/i.test(normalized) &&
          !normalized.includes('€') &&
          !normalized.includes('%') &&
          !/RETAIL PRICE|FINAL PRICE|SALE|SPRING|SUMMER|FALL|WINTER/i.test(normalized)
        );
      });
 
      const variantRows = [];
      const rows = Array.from(el.querySelectorAll('.rowSingle'));
 
      for (const row of rows) {
        const sizeEl =
          row.querySelector('[data-title="size"]') ||
          row.querySelector('.ectable_variants');
 
        const stockEl =
          row.querySelector('[data-title="in stock"]') ||
          row.children?.[1];
 
        const sizeText = (sizeEl?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();
 
        const stockText = (stockEl?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();
 
        const stockMatch = stockText.match(/\d+/);
 
        if (!sizeText || !stockMatch) continue;
 
        const supplierSize = sizeText;
        const stockQty = Number(stockMatch[0]);
        const rowTextLower = String(row.innerText || '').toLowerCase();
 
        if (supplierSize.toLowerCase() === 'm' && rowTextLower.includes('cm')) {
          continue;
        }
 
        const key = `${supplierSize}|${stockQty}`;
        if (!variantRows.some(v => v.key === key)) {
          variantRows.push({
            key,
            supplier_size: supplierSize,
            stock_quantity: stockQty,
            raw_text: row.innerText
          });
        }
      }
 
      for (const v of variantRows) {
        delete v.key;
      }
 
      return {
        lines,
        brand,
        season: seasonLine,
        product_code: productCodeLine,
        money_matches: moneyMatches,
        discount_percent: discountMatch ? discountMatch[0] : null,
        image_urls: imageUrls,
        variant_rows: variantRows,
        product_url: productUrl
      };
    });
 
    const productCode = cleanText(data.product_code);

    if (!productCode) {
      skipped++;
      continue;
    }
 
    const retailPrice = toNumber(data.money_matches[0]);
    const finalPrice = toNumber(
      data.money_matches[data.money_matches.length - 1]
    ) ?? toNumber(data.money_matches[0]);
 
    const discountPercent = data.discount_percent
      ? Math.abs(toNumber(data.discount_percent))
      : null;
 
    const seasonRaw = cleanText(data.season);
    const isSale = String(seasonRaw || '').trim().toLowerCase() === 'sale';
 
    const brandSlug = buildSlug(data.brand);
    const productKey = `${brandSlug}-${productCode}-unknown`;
 
    const scannedAt = new Date().toISOString();
 
    const variantsRaw = data.variant_rows.length
      ? data.variant_rows.map(v => {
          const size = cleanText(v.supplier_size);
          return {
            supplier_size: size,
            supplier_sku: `${productCode}-${size}`,
            supplier_variant_code: `${productCode}-${size}`,
            stock_quantity: v.stock_quantity,
            is_available: v.stock_quantity > 0,
            supplier_retail_price: retailPrice,
            supplier_final_price: finalPrice,
            supplier_discount_percent: discountPercent,
            currency: 'EUR',
            raw_variant_json: v
          };
        })
      : [{
          supplier_size: 'U',
          supplier_sku: `${productCode}-U`,
          supplier_variant_code: `${productCode}-U`,
          stock_quantity: 1,
          is_available: true,
          supplier_retail_price: retailPrice,
          supplier_final_price: finalPrice,
          supplier_discount_percent: discountPercent,
          currency: 'EUR',
          raw_variant_json: {
            fallback: true,
            reason: 'No variant rows found in listing'
          }
        }];
 
    // ✅ FIX 9: totalStock считаем из реальных вариантов (после
    // построения variantsRaw), единообразно с нодой Split Products.
    const totalStock = variantsRaw.reduce(
      (sum, v) => sum + (Number(v.stock_quantity) || 0),
      0
    );
 
    const { hash: productHash, hashSource } = buildProductHash({
      supplierFinalPrice: finalPrice,
      supplierRetailPrice: retailPrice,
      supplierDiscountPercent: discountPercent,
      isActive: true,
      isArchived: false,
      totalStock
    });
 
    const imagesRaw = data.image_urls
      .filter(url => url && url.startsWith('http'))
      .map((url, index) => ({
        url,
        image_url: url,
        supplier_image_url: url,
        position: index + 1,
        image_position: index + 1,
        type: index === 0 ? 'main' : 'gallery',
        image_type: index === 0 ? 'main' : 'gallery',
        is_main: index === 0
      }));
 
    const product = {
      supplier_name: SUPPLIER_NAME,
      supplier_slug: SUPPLIER_SLUG,
      supplier_sku: productCode,
      supplier_product_code: productCode,
      supplier_product_url: data.product_url || null,
      listing_url: buildPageUrl(pageNumber),
      found_on_page: pageNumber,

      brand_raw: cleanText(data.brand),
      title_raw: null,
      description_raw: null,
      gender_raw: null,
      category_raw: null,
      subcategory_raw: null,
      type_raw: null,
      color_raw: null,
      season_raw: seasonRaw,
      composition_raw: null,
      made_in_raw: null,
      size_and_fit_raw: null,
 
      supplier_retail_price: retailPrice,
      supplier_final_price: finalPrice,
      supplier_discount_percent: discountPercent,
      currency: 'EUR',
      is_sale: isSale,
 
      product_key: productKey,
      product_hash: productHash,
      hash_source: hashSource,
 
      images_raw: imagesRaw,
      variants_raw: variantsRaw,
 
      raw_json: {
        source: 'listing_delta_only',
        page_number: pageNumber,
        card_index: i + 1,
        lines: data.lines,
        image_urls: data.image_urls,
        variant_rows: data.variant_rows,
        product_url: data.product_url
      },
 
      scrape_status: 'ingested',
      scan_mode: 'delta',
 
      is_active: true,
      is_archived: false,
 
      scanned_at: scannedAt,
      ingested_at: scannedAt
    };
 
    products.push(product);
 
    console.log(`[DELTA OK] p${pageNumber}#${i+1} ${product.brand_raw} ${product.supplier_product_code} url:${data.product_url ? 'YES' : 'NO'} retail:${retailPrice} final:${finalPrice} vars:${variantsRaw.length}`);
  }
 
  console.log(`[DELTA PAGE ${pageNumber}] collected:${products.length} skipped:${skipped}`);
  return products;
}
 
// ─── SEND WEBHOOK ─────────────────────────────────────────
 
async function sendWebhook(products, batchIndex) {
  if (!process.env.N8N_WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is missing');
  }
 
  console.log(`[WEBHOOK] Sending batch ${batchIndex + 1}... products: ${products.length}`);
 
  const response = await axios.post(
    process.env.N8N_WEBHOOK_URL,
    {
      supplier_name: SUPPLIER_NAME,
      supplier_slug: SUPPLIER_SLUG,
      source: 'julian_delta_listing_only',
      scan_mode: 'delta',
      scraped_at: new Date().toISOString(),
      products
    },
    {
      timeout: 120000,
      headers: {
        'x-wbb-secret': process.env.WBB_WEBHOOK_SECRET
      }
    }
  );
 
  console.log(`[WEBHOOK] Batch ${batchIndex + 1} status: ${response.status} — sent successfully`);
}
 
async function sendInBatches(allProducts) {
  const total = allProducts.length;
  const batches = Math.ceil(total / BATCH_SIZE);
 
  console.log(`[WEBHOOK] Sending ${total} products in ${batches} batches of ${BATCH_SIZE}`);
 
  for (let i = 0; i < batches; i++) {
    const batch = allProducts.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    await sendWebhook(batch, i);
 
    if (i < batches - 1) {
      console.log(`[WEBHOOK] Waiting 5s before next batch...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
 
  console.log(`[WEBHOOK] All ${batches} batches sent successfully`);
}
 
// ─── MAIN ─────────────────────────────────────────────────
 
async function run() {
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();

  const acquired = await tryAcquireRunLock();
  if (!acquired) {
    console.log(`[LOCK] ${LOCK_NAME} run already in progress — skipping this run`);
    return;
  }

  try {
    const gateCheck = await checkSupplierGate();
    if (gateCheck.blocked) {
      console.log(`[GATE] julian-fashion blocked until ${gateCheck.gate.cooldown_until} — skipping delta scan entirely`);
      return;
    }

    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1400 }
    });

    page.setDefaultTimeout(30000);

    const allProducts = [];
    let pagesScanned = 0;
    let totalItemsCollected = 0;
    let abortReason = null;
    let consecutiveFailures = 0;
    let failedPages = 0;
    let pagesSinceFlush = 0;

    try {
      await login(page);

      if (SOURCE_MODE === 'csv_export') {
        // ✅ Новая ветка: обновление цен/остатков УЖЕ известных товаров
        // через полный CSV-экспорт, без обхода страниц листинга. Discovery
        // новых SKU / found_on_page для WF07 этот путь не даёт — для этого
        // по-прежнему нужен обычный SOURCE_MODE='listing' прогон.
        console.log('[DELTA] SOURCE_MODE=csv_export — skipping listing pagination');
        const products = await downloadAndParseCsvExport(page);
        if (!products.length) {
          throw new Error('CSV export parsed 0 products');
        }
        await sendInBatches(products);
        console.log(`[DELTA] CSV EXPORT FINISHED. Products sent: ${products.length}`);
        return;
      }

      const END_PAGE = START_PAGE + MAX_PAGES - 1;
      console.log(`[DELTA] Scanning pages ${START_PAGE} to ${END_PAGE}`);

      for (let currentPage = START_PAGE; currentPage <= END_PAGE; currentPage++) {
        // единая точка проверки: gate / лок / таймаут
        const [gate, lockOwned] = await Promise.all([checkSupplierGate(), checkLockStillOwned()]);
        const elapsedMinutes = (Date.now() - startedAtMs) / 60000;

        if (gate.blocked) {
          abortReason = 'aborted_gate';
          console.log(`[GATE] blocked mid-scan at page ${currentPage} — clean abort`);
          break;
        }
        if (!lockOwned) {
          abortReason = 'aborted_lock_lost';
          console.log(`[LOCK] ownership lost at page ${currentPage} — clean abort`);
          break;
        }
        if (elapsedMinutes > MAX_RUN_MINUTES) {
          abortReason = 'aborted_timeout';
          console.log(`[TIMEOUT] MAX_RUN_MINUTES=${MAX_RUN_MINUTES} exceeded at page ${currentPage} — clean abort`);
          break;
        }

        // ✅ п.4: одна плохая страница — try/catch на уровне страницы,
        // не всего прогона
        let productCount;
        let pageProducts;
        try {
          productCount = await openListing(page, currentPage);

          if (!productCount) {
            console.log('[DELTA] No products found. Stop pagination.');
            break;
          }

          pageProducts = await collectProductsFromListing(page, currentPage);
        } catch (pageError) {
          failedPages++;
          consecutiveFailures++;
          console.error(
            `[PAGE ERROR] page ${currentPage} failed (consecutive:${consecutiveFailures}, total:${failedPages}):`,
            pageError.message
          );

          // ✅ п.5: 2+ подряд ИЛИ >5% за прогон (после минимальной выборки
          // в 20 попыток — единичный сбой в начале не должен читаться как
          // 33%-ная катастрофа)
          const attempted = pagesScanned + failedPages;
          const failureRate = attempted > 0 ? failedPages / attempted : 0;
          const enoughSample = attempted >= POISON_PAGE_MIN_SAMPLE;

          if (
            consecutiveFailures >= POISON_PAGE_CONSECUTIVE_THRESHOLD ||
            (enoughSample && failureRate > POISON_PAGE_RATE_THRESHOLD)
          ) {
            abortReason = 'aborted_poison_pages';
            console.log(
              `[POISON PAGE] abort at page ${currentPage} — consecutive:${consecutiveFailures}, rate:${(failureRate * 100).toFixed(1)}%`
            );
            break;
          }

          continue;
        }

        consecutiveFailures = 0;
        allProducts.push(...pageProducts);
        totalItemsCollected += pageProducts.length;
        pagesScanned++;
        pagesSinceFlush++;

        // ✅ п.6: прогрессивная отправка — не ждём конца скана
        if (pagesSinceFlush >= FLUSH_EVERY_PAGES) {
          console.log(`[FLUSH] Sending ${allProducts.length} products from last ${pagesSinceFlush} pages...`);
          await sendInBatches(allProducts);
          allProducts.length = 0;
          pagesSinceFlush = 0;
        }

        if (currentPage < END_PAGE) {
          await page.waitForTimeout(3000 + Math.random() * 2000);
        }
      }

      console.log('========================');
      console.log(
        '[DELTA] SCAN FINISHED. Pages scanned:', pagesScanned,
        'Failed pages:', failedPages,
        'Total items collected:', totalItemsCollected,
        'Unflushed remainder:', allProducts.length
      );
      console.log('========================');

      if (allProducts.length) {
        await sendInBatches(allProducts);
      } else if (!abortReason && pagesScanned === 0) {
        throw new Error('No products collected');
      }

      if (abortReason) {
        await writeAbortSyncLog(abortReason, startedAtIso, pagesScanned, totalItemsCollected);
      }

    } finally {
      await browser.close();
    }
  } finally {
    await releaseRunLock();
  }
}
 
run().catch(error => {
  console.error('[FATAL]', error.message);
  if (error.response) {
    console.error('[FATAL] Response status:', error.response.status);
    console.error('[FATAL] Response data:', JSON.stringify(error.response.data));
  }
  process.exit(1);
});
