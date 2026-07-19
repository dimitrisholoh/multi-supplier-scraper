const http = require('http');
const { chromium } = require('playwright');
const axios = require('axios');
const crypto = require('crypto');
 
const PORT = process.env.PORT || 8080;
 
const SUPPLIER_NAME = 'Julian Fashion Srl';
const SUPPLIER_SLUG = 'julian-fashion';
const LISTING_URL = process.env.JULIAN_LISTING_URL || 'https://b2bfashion.online/306-all';
 
const RAW_PRODUCTS_TABLE = 'supplier_raw_products';

let globalBrowser = null;
let globalPage = null;
let isInitialized = false;
let isInitializing = false;
let listingNavigationBusy = false;

// Session-level кэш (вариант a): тексты карточек уже отсканированных
// listing-страниц, keyed by pageNumber. TTL-based, in-memory, НЕ переживает
// рестарт воркера (module-level Map, не Supabase/Redis).
const listingCardsCache = new Map(); // pageNumber -> { cards: string[], scannedAt: number }
const LISTING_CACHE_TTL_MS = Number(process.env.FULL_WORKER_CACHE_TTL_MS || 300000); // 5 мин default

function getCachedListingCards(pageNumber) {
  const entry = listingCardsCache.get(pageNumber);
  if (!entry) return null;
  if (Date.now() - entry.scannedAt > LISTING_CACHE_TTL_MS) {
    listingCardsCache.delete(pageNumber);
    return null;
  }
  return entry.cards;
}

function setCachedListingCards(pageNumber, cards) {
  listingCardsCache.set(pageNumber, { cards, scannedAt: Date.now() });
}

// ✅ FIX 1: buildSlug функция
function buildSlug(value) {
  if (!value) return 'unknown';
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/['\u2019\u2018]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}
 
function cleanText(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned || null;
}
 
// ✅ FIX 9: makeHash оставлена как утилита, но больше НЕ используется
// для пересчёта product_hash. product_hash принадлежит delta-логике
// (price/stock) и full worker не должен его трогать.
function makeHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
 
function getSupabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
 
  if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is missing');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is missing');
 
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}
 
async function getRawProduct(rawProductId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${RAW_PRODUCTS_TABLE}?id=eq.${rawProductId}&limit=1`;
 
  const response = await axios.get(url, {
    headers: getSupabaseHeaders(),
    timeout: 30000
  });
 
  const product = response.data?.[0];
 
  if (!product) {
    throw new Error(`Raw product not found: ${rawProductId}`);
  }
 
  return product;
}
 
async function updateRawProduct(rawProductId, data) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${RAW_PRODUCTS_TABLE}?id=eq.${rawProductId}`;
 
  // ✅ FIX (Prepare Full Images dependency): getSupabaseHeaders() уже
  // содержит Prefer: return=representation, поэтому PATCH здесь
  // корректно возвращает обновлённую запись включая images_raw.
  const response = await axios.patch(url, data, {
    headers: getSupabaseHeaders(),
    timeout: 30000
  });
 
  return response.data?.[0] || null;
}
 
function getFeature(product, name) {
  const target = String(name).toLowerCase().trim();
 
  const direct =
    product[name] ||
    product[target] ||
    product[name.replaceAll(' ', '_')] ||
    product[target.replaceAll(' ', '_')];
 
  if (direct) return cleanText(direct);
 
  const features = product.grouped_features || product.features || product.attributes || {};
 
  if (Array.isArray(features)) {
    for (const item of features) {
      const itemName = String(item?.name || '').toLowerCase().trim();
      if (itemName === target) {
        return cleanText(item?.value || item?.reference || item?.name);
      }
    }
  }
 
  if (features && typeof features === 'object') {
    for (const [key, item] of Object.entries(features)) {
      const keyNorm = String(key).toLowerCase().trim();
      const itemName = String(item?.name || item?.group || item?.label || '')
        .toLowerCase()
        .trim();
 
      if (keyNorm === target || itemName === target) {
        return cleanText(item?.value || item?.reference || item?.name || item);
      }
    }
  }
 
  return null;
}
 
function extractImagesFromHtml(html) {
  if (!html) return [];
 
  const urls = [];
  const decoded = html.replaceAll('\\/', '/');
 
  const matches = decoded.matchAll(
    /https:\/\/julianfashionstorage\.blob\.core\.windows\.net\/jbc\/[^"'<> ]+\.(jpg|jpeg|png|webp)/gi
  );
 
  for (const match of matches) {
    const url = cleanText(match[0]);
    if (url && !urls.includes(url)) urls.push(url);
  }
 
  return urls;
}
 
function extractFullImages(product, quickviewHtml, existingImages = []) {
  const images = [];
 
  const addImage = (url, raw = null) => {
    const cleanUrl = cleanText(url);
    if (!cleanUrl) return;
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    if (images.some(img => img.url === cleanUrl)) return;
 
    images.push({
      url: cleanUrl,
      image_url: cleanUrl,
      supplier_image_url: cleanUrl,
      position: images.length + 1,
      image_position: images.length + 1,
      type: images.length === 0 ? 'main' : 'gallery',
      image_type: images.length === 0 ? 'main' : 'gallery',
      is_main: images.length === 0,
      raw
    });
  };
 
  if (Array.isArray(existingImages)) {
    for (const img of existingImages) {
      if (typeof img === 'string') addImage(img, img);
      else addImage(img?.url || img?.image_url || img?.supplier_image_url, img);
    }
  }
 
  extractImagesFromHtml(quickviewHtml).forEach(url => addImage(url, 'quickview_html'));
 
  if (Array.isArray(product.images)) {
    for (const img of product.images) {
      if (typeof img === 'string') {
        addImage(img, img);
      } else {
        addImage(img?.url, img);
        addImage(img?.large?.url, img);
        addImage(img?.medium?.url, img);
        addImage(img?.bySize?.large_default?.url, img);
        addImage(img?.bySize?.home_default?.url, img);
      }
    }
  }
 
  addImage(product.cover?.url, product.cover);
  addImage(product.cover?.large?.url, product.cover);
  addImage(product.cover?.medium?.url, product.cover);
  addImage(product.cover?.bySize?.large_default?.url, product.cover);
  addImage(product.cover?.bySize?.home_default?.url, product.cover);
 
  return images;
}
 
async function login(page) {
  console.log('Opening Julian login page...');
 
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

  console.log('Login completed. URL:', page.url());

  const passwordFieldStillPresent = await page.locator('input[type="password"]').count();
  const stillOnLoginUrl = page.url().includes('login') || !page.url().includes('b2bfashion.online');
  if (passwordFieldStillPresent > 0 || stillOnLoginUrl) {
    throw new Error(`LOGIN_FAILED: password field present=${passwordFieldStillPresent > 0}, stillOnLoginUrl=${stillOnLoginUrl}, url=${page.url()}`);
  }
}

async function initSession() {
  if (isInitializing) {
    while (isInitializing) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return;
  }
  isInitializing = true;
  try {
    console.log('[SESSION] Initializing browser session...');
    globalBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    globalPage = await globalBrowser.newPage({
      viewport: { width: 1440, height: 1200 }
    });
    globalPage.setDefaultTimeout(30000);
    await login(globalPage);
    isInitialized = true;
    console.log('[SESSION] Browser session ready.');
    globalBrowser.on('disconnected', async () => {
      console.log('[SESSION] Browser disconnected, re-initializing...');
      isInitialized = false;
      await initSession().catch(err =>
        console.error('[SESSION] Re-init failed:', err.message)
      );
    });
  } finally {
    isInitializing = false;
  }
}

async function ensureSession() {
  if (!isInitialized || !globalPage) {
    console.log('[SESSION] Not initialized, starting session...');
    await initSession();
    return;
  }
  if (globalPage.url().includes('login')) {
    console.log('[SESSION] Session expired (url:', globalPage.url(), '), re-initializing...');
    isInitialized = false;
    await initSession();
  }
}

async function openListing(page, pageNumber = 1) {
  const pageUrl = pageNumber > 1 ? `${LISTING_URL}?page=${pageNumber}` : LISTING_URL;
 
  console.log('Opening listing URL:', pageUrl);
 
  await page.goto(pageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });
 
  await page.waitForTimeout(12000);
 
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(700);
  }
 
  const count = await page.locator('.product-miniature').count();
  console.log('Products found on page:', count);
  return count;
}
 
async function closeModal(page) {
  const selectors = [
    '.quickview .close',
    '.modal .close',
    'button.close',
    '[data-dismiss="modal"]',
    '.modal button[aria-label="Close"]'
  ];
 
  for (const selector of selectors) {
    const btn = page.locator(selector).first();
    if (await btn.count()) {
      await btn.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(700);
      return;
    }
  }
 
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(700);
}
 
async function findCardIndexByProductCode(page, supplierProductCode) {
  const cards = page.locator('.product-miniature');
  const count = await cards.count();

  for (let i = 0; i < count; i++) {
    const text = await cards.nth(i).innerText().catch(() => '');
    if (text.includes(supplierProductCode)) {
      return i;
    }
  }

  return -1;
}

async function extractCardTexts(page) {
  const cards = page.locator('.product-miniature');
  const count = await cards.count();
  const texts = [];
  for (let i = 0; i < count; i++) {
    texts.push(await cards.nth(i).innerText().catch(() => ''));
  }
  return texts;
}

async function clickQuickviewByCardIndex(page, cardIndex, supplierProductCode) {
  let capturedUrl = null;
 
  const onRequest = request => {
    const url = request.url();
    if (
      url.includes('controller=product') &&
      url.includes('action=quickview') &&
      url.includes('id_product')
    ) {
      capturedUrl = url;
      console.log('CAPTURED QUICKVIEW URL:', url);
    }
  };
 
  page.on('request', onRequest);
 
  try {
    const cardLocator = page.locator('.product-miniature').nth(cardIndex);
 
    await cardLocator.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1000);
    await cardLocator.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(700);
 
    const button = cardLocator
      .locator('[data-link-action="quickview"], .quick-view, .button-action.quick-view')
      .first();
 
    if (!(await button.count())) {
      throw new Error(`Quickview button not found for ${supplierProductCode}`);
    }
 
    const responsePromise = page.waitForResponse(
      response => {
        const url = response.url();
        return (
          response.status() === 200 &&
          url.includes('controller=product') &&
          url.includes('action=quickview') &&
          url.includes('id_product')
        );
      },
      { timeout: 12000 }
    ).catch(() => null);
 
    await button.click({ force: true, timeout: 10000 });
 
    let json = null;
    const response = await responsePromise;
 
    if (response) {
      console.log('CAPTURED RESPONSE URL:', response.url());
      json = await response.json();
    }
 
    if (!json && capturedUrl) {
      console.log('Fallback direct request:', capturedUrl);
 
      const directResponse = await page.request.get(capturedUrl, {
        timeout: 30000,
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01'
        }
      });
 
      if (!directResponse.ok()) {
        throw new Error(`Fallback request failed: ${directResponse.status()}`);
      }
 
      json = await directResponse.json();
    }
 
    if (!json) throw new Error('No quickview response and no captured URL');
    if (!json.product) throw new Error('No product in quickview response');
 
    return {
      product: json.product,
      quickview_html: json.quickview_html || ''
    };
  } finally {
    page.off('request', onRequest);
    await closeModal(page);
  }
}
 
function buildEnrichedPayload(rawProduct, product, quickviewHtml) {
  const existingRawJson = rawProduct.raw_json || {};
  const existingImages = rawProduct.images_raw || [];
 
  const titleRaw = cleanText(product.name || product.title || rawProduct.title_raw);
  const descriptionRaw = cleanText(product.description || rawProduct.description_raw);
 
  const colorRaw = getFeature(product, 'color') || rawProduct.color_raw;
  const compositionRaw = getFeature(product, 'composition') || rawProduct.composition_raw;
 
  const madeInRaw =
    getFeature(product, 'made in') ||
    getFeature(product, 'made_in') ||
    getFeature(product, 'country') ||
    getFeature(product, 'origin') ||
    rawProduct.made_in_raw;
 
  const categoryRaw =
    cleanText(getFeature(product, 'category') || product.category_name || product.category) ||
    rawProduct.category_raw;
 
  const typeRaw = getFeature(product, 'type') || rawProduct.type_raw;
  const genderRaw = getFeature(product, 'gender') || rawProduct.gender_raw;
 
  const sizeAndFitRaw =
    cleanText(getFeature(product, 'size and fit') || getFeature(product, 'fit')) ||
    rawProduct.size_and_fit_raw;
 
  const imagesRaw = extractFullImages(product, quickviewHtml, existingImages);
 
  const supplierProductUrl =
    cleanText(product.link) ||
    cleanText(product.url) ||
    cleanText(rawProduct.supplier_product_url) ||
    null;
 
  // ✅ FIX 9: product_hash здесь НЕ пересчитывается и НЕ возвращается.
  // product_hash принадлежит delta price/stock логике (Split Products
  // нода и scrape-julian-delta.js). Full worker меняет только
  // enrichment-поля (title/color/images/etc) и не должен трогать
  // продукт-хэш, иначе следующий delta прогон будет считать, что
  // продукт всегда "изменился" из-за несовпадения алгоритмов хэша.
  //
  // Если в будущем понадобится отдельный хэш для отслеживания
  // изменений именно enrichment-данных — используем отдельное поле
  // enrichment_hash, не product_hash.
  const enrichmentHash = makeHash({
    supplier_slug: SUPPLIER_SLUG,
    supplier_product_code: rawProduct.supplier_product_code,
    title_raw: titleRaw,
    description_raw: descriptionRaw,
    color_raw: colorRaw,
    composition_raw: compositionRaw,
    made_in_raw: madeInRaw,
    images_count: imagesRaw.length
  });
 
  // ✅ FIX 2: product_key строится после enrichment
  const colorSlug = buildSlug(colorRaw || 'unknown');
  const productKey = `${buildSlug(rawProduct.brand_raw)}-${rawProduct.supplier_product_code}-${colorSlug}`;
 
  return {
    title_raw: titleRaw,
    description_raw: descriptionRaw,
    gender_raw: genderRaw,
    category_raw: categoryRaw,
    type_raw: typeRaw,
    color_raw: colorRaw,
    composition_raw: compositionRaw,
    made_in_raw: madeInRaw,
    size_and_fit_raw: sizeAndFitRaw,
    supplier_product_url: supplierProductUrl,
    product_key: productKey,
    images_raw: imagesRaw,
    // ✅ FIX 9: product_hash больше не входит в этот payload —
    // PATCH к Supabase не тронет существующее значение поля.
    enrichment_hash: enrichmentHash,
    raw_json: {
      ...existingRawJson,
      full_enrichment: {
        product,
        quickview_html: quickviewHtml,
        enriched_at: new Date().toISOString()
      }
    },
    enrichment_needed: false,
    // ✅ FIX 10: enrichment_status унифицирован на 'done'
    // (вместо нестандартного 'completed').
    enrichment_status: 'done',
    enrichment_reason: ['julian_full_card_scan_completed'],
    enriched_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}
 
async function enrichJulianProduct(rawProductId) {
  console.log('==============================');
  console.log('JULIAN FULL ENRICHMENT START');
  console.log('raw_product_id:', rawProductId);
  console.log('==============================');
 
  const rawProduct = await getRawProduct(rawProductId);
 
  if (rawProduct.supplier_slug !== SUPPLIER_SLUG) {
    throw new Error(`Wrong supplier_slug: ${rawProduct.supplier_slug}`);
  }
 
  const supplierProductCode = cleanText(rawProduct.supplier_product_code);
 
  if (!supplierProductCode) {
    throw new Error('supplier_product_code is missing');
  }
 
  try {
    await ensureSession();

    // ✅ FIX 3: maxPages 3 → 10
    const maxPages = Number(process.env.JULIAN_FULL_MAX_PAGES || 10);
 
    let directUrl = null;
    let isQuickviewUrl = false;
    const supplierUrl = rawProduct.supplier_product_url;
    console.log('[ENRICH] supplier_product_url:', supplierUrl);

    if (supplierUrl && supplierUrl.startsWith('http')) {
      const quickviewMatch = supplierUrl.match(/[?&]id_product=(\d+)/);
      const productPageMatch = supplierUrl.match(/\/(\d+)-[^/]+\.html/);

      if (quickviewMatch) {
        directUrl = supplierUrl;
        isQuickviewUrl = true;
        console.log('[ENRICH] fast path: quickview URL used directly:', directUrl);
      } else if (productPageMatch) {
        // Product page URL (/N-code.html) set after first enrichment — use directly.
        // Verified: page.goto() on this URL finds #product-details[data-product] with full product JSON.
        directUrl = supplierUrl;
        console.log('[ENRICH] fast path: product page URL used directly:', directUrl);
      } else {
        console.log('[ENRICH] fast path skipped: URL does not match known patterns');
      }
    } else {
      console.log('[ENRICH] fast path skipped: supplier_product_url missing or not http');
    }

    if (directUrl) {
      try {
        console.log('[ENRICH] trying direct URL:', { supplierProductCode, directUrl });

        if (isQuickviewUrl) {
          const cookies = await globalPage.context().cookies();
          const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

          const directResponse = await axios.get(directUrl, {
            timeout: 30000,
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              Accept: 'application/json, text/javascript, */*; q=0.01',
              Referer: 'https://b2bfashion.online/306-all',
              Cookie: cookieHeader
            }
          });

          const json = directResponse.data;
          if (!json.product) throw new Error('No product in quickview response');

          const updatePayload = buildEnrichedPayload(rawProduct, json.product, json.quickview_html || '');
          const updated = await updateRawProduct(rawProductId, updatePayload);

          console.log('JULIAN FULL ENRICHMENT COMPLETED (direct quickview):', {
            raw_product_id: rawProductId,
            supplier_product_code: supplierProductCode,
            product_key: updatePayload.product_key,
            images_count: updatePayload.images_raw.length
          });

          return { ok: true, raw_product_id: rawProductId, supplier_product_code: supplierProductCode, updated };

        } else {
          while (listingNavigationBusy) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          listingNavigationBusy = true;
          try {
            await globalPage.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await globalPage.waitForSelector('#product-details', { timeout: 40000, state: 'attached' });

            const rawDataProduct = await globalPage.getAttribute('#product-details', 'data-product');
            const product = JSON.parse(rawDataProduct);
            const fullHtml = await globalPage.content();

            const updatePayload = buildEnrichedPayload(rawProduct, product, fullHtml);
            const updated = await updateRawProduct(rawProductId, updatePayload);

            console.log('JULIAN FULL ENRICHMENT COMPLETED (direct):', {
              raw_product_id: rawProductId,
              supplier_product_code: supplierProductCode,
              product_key: updatePayload.product_key,
              images_count: updatePayload.images_raw.length
            });

            return { ok: true, raw_product_id: rawProductId, supplier_product_code: supplierProductCode, updated };
          } finally {
            listingNavigationBusy = false;
          }
        }
      } catch (directError) {
        console.log('[ENRICH] direct URL failed, falling back to listing search:', {
          supplierProductCode,
          directUrl,
          error: directError.message
        });
      }
    }
 
    while (listingNavigationBusy) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    listingNavigationBusy = true;
    try {
    let found = null;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const cachedCards = getCachedListingCards(pageNumber);
      let cardTexts;
      let navigatedThisIteration = false;

      if (cachedCards) {
        console.log('[CACHE] listing page hit:', {
          pageNumber,
          age_ms: Date.now() - listingCardsCache.get(pageNumber).scannedAt,
          cards: cachedCards.length
        });
        cardTexts = cachedCards;
      } else {
        await openListing(globalPage, pageNumber);
        navigatedThisIteration = true;

        let currentUrl = globalPage.url();
        if (currentUrl.includes('login') || !currentUrl.includes('b2bfashion.online')) {
          console.log('[SESSION] Redirect detected after openListing (url:', currentUrl, '), re-initializing...');
          isInitialized = false;
          await initSession();
          await openListing(globalPage, pageNumber);

          currentUrl = globalPage.url();
          if (currentUrl.includes('login') || !currentUrl.includes('b2bfashion.online')) {
            throw new Error(`LOGIN_FAILED: still on login/off-domain after retry, url=${currentUrl}, page=${pageNumber}`);
          }
        }

        cardTexts = await extractCardTexts(globalPage);
        if (cardTexts.length > 0) {
          setCachedListingCards(pageNumber, cardTexts);
        } else {
          console.log('[CACHE] skip caching empty page result:', { pageNumber });
        }
      }

      const cardIndex = cardTexts.findIndex(text => text.includes(supplierProductCode));

      if (cardIndex >= 0) {
        if (!navigatedThisIteration) {
          console.log('[CACHE] re-navigating to matched page for live DOM click:', { pageNumber, cardIndex });
          await openListing(globalPage, pageNumber);

          let currentUrl = globalPage.url();
          if (currentUrl.includes('login') || !currentUrl.includes('b2bfashion.online')) {
            console.log('[SESSION] Redirect detected after openListing (url:', currentUrl, '), re-initializing...');
            isInitialized = false;
            await initSession();
            await openListing(globalPage, pageNumber);

            currentUrl = globalPage.url();
            if (currentUrl.includes('login') || !currentUrl.includes('b2bfashion.online')) {
              throw new Error(`LOGIN_FAILED: still on login/off-domain after retry (live-click path), url=${currentUrl}, page=${pageNumber}`);
            }
          }
        }

        console.log('Product card found:', {
          supplierProductCode, pageNumber, cardIndex, from_cache: !navigatedThisIteration
        });
        found = { pageNumber, cardIndex };
        break;
      }

      console.log('Product not found on page:', { supplierProductCode, pageNumber, from_cache: !!cachedCards });
    }
 
    if (!found) {
      throw new Error(`Product card not found in listing: ${supplierProductCode}`);
    }
 
    const { product, quickview_html } = await clickQuickviewByCardIndex(
      globalPage,
      found.cardIndex,
      supplierProductCode
    );
 
    const updatePayload = buildEnrichedPayload(rawProduct, product, quickview_html);
    const updated = await updateRawProduct(rawProductId, updatePayload);
 
    console.log('JULIAN FULL ENRICHMENT COMPLETED:', {
      raw_product_id: rawProductId,
      supplier_product_code: supplierProductCode,
      product_key: updatePayload.product_key,
      supplier_product_url: updatePayload.supplier_product_url,
      title_raw: updatePayload.title_raw,
      color_raw: updatePayload.color_raw,
      images_count: updatePayload.images_raw.length
    });
 
    return {
      ok: true,
      raw_product_id: rawProductId,
      supplier_product_code: supplierProductCode,
      updated
    };
    } finally {
      listingNavigationBusy = false;
    }
  } catch (error) {
    console.error('JULIAN FULL ENRICHMENT ERROR:', error.message);
 
    if (error.response) {
      console.error('ERROR STATUS:', error.response.status);
      console.error('ERROR DATA:', JSON.stringify(error.response.data, null, 2));
    }

    await updateRawProduct(rawProductId, {
      enrichment_status: 'error',
      enrichment_needed: true,
      enrichment_reason: [error.message],
      updated_at: new Date().toISOString()
    }).catch(updateError => {
      console.error('Failed to mark enrichment error:', updateError.message);
    });
 
    throw error;
  }
}
 
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}
 
const HEARTBEAT_INTERVAL_MS = Number(process.env.JULIAN_FULL_HEARTBEAT_MS || 60000);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'julian_full_worker' }));
    }

    // ✅ FIX 5: WORKER_SECRET авторизация
    const SECRET = process.env.WORKER_SECRET;
    if (SECRET && req.headers['x-worker-secret'] !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    }

    if (req.method === 'POST' && req.url === '/enrich') {
      if (!isInitialized) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Service initializing, retry shortly' }));
      }

      const payload = await readJsonBody(req);
      const rawProductId = payload.raw_product_id || payload.id;

      if (!rawProductId) {
        throw new Error('raw_product_id is missing');
      }

      // Headers коммитятся сразу, чтобы периодические write() ниже не давали
      // Railway edge посчитать соединение простаивающим (5-мин idle-лимит,
      // см. 08_BACKLOG.md §0г). Статус теперь всегда 200 — успех/неудача
      // сигналится через `ok` в теле, не через HTTP-статус.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const heartbeat = setInterval(() => {
        try {
          if (!res.writableEnded && !res.destroyed) {
            res.write(' ');
          }
        } catch (err) {
          console.error('[HEARTBEAT] write failed (client likely disconnected):', err.message);
        }
      }, HEARTBEAT_INTERVAL_MS);

      let result;
      try {
        result = await enrichJulianProduct(rawProductId);
      } catch (error) {
        result = { ok: false, error: error.message };
      } finally {
        clearInterval(heartbeat);
      }

      return res.end(JSON.stringify(result));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (error) {
    console.error('Worker request error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});
 
server.listen(PORT, () => {
  console.log(`Julian full enrichment worker listening on port ${PORT}`);
  initSession().catch(err => {
    console.error('[SESSION] Failed to initialize:', err.message);
    process.exit(1);
  });
});
