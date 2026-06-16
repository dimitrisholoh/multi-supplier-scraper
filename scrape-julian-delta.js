const { chromium } = require('playwright');
const axios = require('axios');
const crypto = require('crypto');

const SUPPLIER_NAME = 'Julian Fashion Srl';
const SUPPLIER_SLUG = 'julian-fashion';

const LIMIT_PRODUCTS = Number(process.env.LIMIT_PRODUCTS || 50);
const START_PAGE = Number(process.env.START_PAGE || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 2);

const LISTING_URL = process.env.JULIAN_LISTING_URL || 'https://b2bfashion.online/306-all';

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

function makeHash(obj) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex');
}

function buildPageUrl(pageNumber) {
  return pageNumber > 1
    ? `${LISTING_URL}?page=${pageNumber}`
    : LISTING_URL;
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
  console.log('[DELTA] PAGE:', pageNumber);
  console.log('[DELTA] URL:', pageUrl);
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

  const productCards = page.locator('.product-miniature');
  const count = await productCards.count();
  const limit = Math.min(count, LIMIT_PRODUCTS);

  console.log('[DELTA] Cards to collect:', limit);

  for (let i = 0; i < limit; i++) {
    const card = productCards.nth(i);

    const data = await card.evaluate(el => {
      const text = el.innerText || '';
      const html = el.innerHTML || '';

      const lines = text
        .split('\n')
        .map(x => x.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

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
        html,
        brand,
        season: seasonLine,
        product_code: productCodeLine,
        money_matches: moneyMatches,
        discount_percent: discountMatch ? discountMatch[0] : null,
        image_urls: imageUrls,
        variant_rows: variantRows
      };
    });

    // ── Validate product code ──
    const productCode = cleanText(data.product_code);

    if (!productCode) {
      console.log('[SKIP] No product code:', {
        page: pageNumber,
        index: i + 1,
        brand: data.brand
      });
      continue;
    }

    // ── Prices ──
    const retailPrice = toNumber(data.money_matches[0]);
    const finalPrice = toNumber(
      data.money_matches[data.money_matches.length - 1]
    );

    // Скидка всегда положительная
    const discountPercent = data.discount_percent
      ? Math.abs(toNumber(data.discount_percent))
      : null;

    // ── Season / Sale ──
    const seasonRaw = cleanText(data.season);
    const isSale =
      String(seasonRaw || '').trim().toLowerCase() === 'sale';

    // ── Product Key ──
    // Формат: brand_slug-product_code-color_slug
    // Delta не знает цвет — используем 'unknown'
    const brandSlug = buildSlug(data.brand);
    const productKey = `${brandSlug}-${productCode}-unknown`;

    // ── Product Hash ──
    // Hash считается только от данных которые меняются
    const scannedAt = new Date().toISOString();

    const variantsForHash = [];

    // ── Variants ──
    const variantsRaw = data.variant_rows.length
      ? data.variant_rows.map(v => {
          const size = cleanText(v.supplier_size);
          variantsForHash.push({
            size,
            stock: v.stock_quantity,
            available: v.stock_quantity > 0
          });
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

    if (!variantsForHash.length) {
      variantsForHash.push({ size: 'U', stock: 1, available: true });
    }

    const productHash = makeHash({
      supplier_slug: SUPPLIER_SLUG,
      supplier_product_code: productCode,
      supplier_final_price: finalPrice,
      supplier_retail_price: retailPrice,
      supplier_discount_percent: discountPercent,
      variants: variantsForHash,
      is_active: true
    });

    // ── Images ──
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

    // ── Build Product ──
    const product = {
      // Поставщик
      supplier_name: SUPPLIER_NAME,
      supplier_slug: SUPPLIER_SLUG,
      supplier_sku: productCode,
      supplier_product_code: productCode,
      supplier_product_url: null,
      listing_url: buildPageUrl(pageNumber),

      // Данные товара (delta знает только часть)
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

      // Цены
      supplier_retail_price: retailPrice,
      supplier_final_price: finalPrice,
      supplier_discount_percent: discountPercent,
      currency: 'EUR',
      is_sale: isSale,

      // Ключи
      product_key: productKey,
      product_hash: productHash,

      // Вложенные массивы
      images_raw: imagesRaw,
      variants_raw: variantsRaw,

      // Raw данные для отладки
      raw_json: {
        source: 'listing_delta_only',
        page_number: pageNumber,
        card_index: i + 1,
        lines: data.lines,
        image_urls: data.image_urls,
        variant_rows: data.variant_rows
      },

      // Статусы
      scrape_status: 'ingested',
      scan_mode: 'delta',

      // Флаги
      is_active: true,
      is_archived: false,

      // Временные метки
      scanned_at: scannedAt,
      ingested_at: scannedAt
    };

    products.push(product);

    console.log('[DELTA OK]', {
      page: pageNumber,
      index: i + 1,
      brand: product.brand_raw,
      code: product.supplier_product_code,
      product_key: product.product_key,
      retail: product.supplier_retail_price,
      final: product.supplier_final_price,
      discount: product.supplier_discount_percent,
      variants: product.variants_raw.length,
      images: product.images_raw.length
    });
  }

  return products;
}

// ─── SEND WEBHOOK ─────────────────────────────────────────

async function sendWebhook(products) {
  if (!process.env.N8N_WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is missing');
  }

  console.log('[WEBHOOK] Sending to n8n...');
  console.log('[WEBHOOK] Products count:', products.length);

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
    { timeout: 120000 }
  );

  console.log('[WEBHOOK] Status:', response.status);
  console.log('[WEBHOOK] Sent successfully');
}

// ─── MAIN ─────────────────────────────────────────────────

async function run() {
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

  const products = [];

  try {
    await login(page);

    const END_PAGE = START_PAGE + MAX_PAGES - 1;

    for (let currentPage = START_PAGE; currentPage <= END_PAGE; currentPage++) {
      const productCount = await openListing(page, currentPage);

      if (!productCount) {
        console.log('[DELTA] No products found. Stop pagination.');
        break;
      }

      const pageProducts = await collectProductsFromListing(page, currentPage);
      products.push(...pageProducts);

      if (currentPage < END_PAGE) {
        await page.waitForTimeout(3000 + Math.random() * 2000);
      }
    }

    console.log('========================');
    console.log('[DELTA] SCAN FINISHED');
    console.log('[DELTA] Total products:', products.length);
    console.log('========================');

    if (!products.length) {
      throw new Error('No products collected');
    }

    await sendWebhook(products);

  } finally {
    await browser.close();
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
