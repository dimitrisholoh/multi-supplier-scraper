const { chromium } = require('playwright');
const axios = require('axios');
const crypto = require('crypto');

const SUPPLIER_NAME = 'Julian Fashion Srl';
const SUPPLIER_SLUG = 'julian-fashion';

const LIMIT_PRODUCTS = Number(process.env.LIMIT_PRODUCTS || 50);
const START_PAGE = Number(process.env.START_PAGE || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 3);

const LISTING_URL = process.env.JULIAN_LISTING_URL || 'https://b2bfashion.online/306-all';

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned || null;
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

function makeHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildPageUrl(pageNumber) {
  return pageNumber > 1 ? `${LISTING_URL}?page=${pageNumber}` : LISTING_URL;
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

  console.log('Login completed');
  console.log('Current URL:', page.url());
}

async function openListing(page, pageNumber) {
  const pageUrl = buildPageUrl(pageNumber);

  console.log('========================');
  console.log('DELTA PAGE:', pageNumber);
  console.log('Opening listing URL:', pageUrl);
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

  console.log('Listing opened');
  console.log('Current listing URL:', page.url());
  console.log('Products found on page:', count);

  return count;
}

async function collectProductsFromListing(page, pageNumber) {
  const products = [];

  const productCards = page.locator('.product-miniature');
  const count = await productCards.count();
  const limit = Math.min(count, LIMIT_PRODUCTS);

  console.log('Listing cards to collect:', limit);

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
          img.getAttribute('src') ||
          img.getAttribute('data-src') ||
          img.getAttribute('data-full-size-image-url')
        )
        .filter(Boolean)
        .map(url => url.replace(/\\/g, ''));

      const moneyMatches = text.match(/€\s?[\d.,]+/g) || [];
      const discountMatch = text.match(/-\s?\d+%/);

      const brand = lines[0] || null;

      const seasonLine =
        lines.find(line =>
          /Spring Summer|Fall Winter|Autumn Winter|SS|FW|Sale/i.test(line)
        ) || null;

      const productCodeLine = lines.find(line => {
        const normalized = line.trim();
        const brandLine = brand ? brand.trim().toUpperCase() : '';

        return (
          normalized.toUpperCase() !== brandLine &&
          /^[A-Z0-9\-]{5,}$/i.test(normalized) &&
          /\d/.test(normalized) &&
          !normalized.includes('€') &&
          !normalized.includes('%') &&
          !/RETAIL PRICE|FINAL PRICE|SALE|SPRING|SUMMER|FALL|WINTER/i.test(normalized)
        );
      });

      const variantRows = [];

      const rowCandidates = Array.from(el.querySelectorAll('tr, .row, li, div'));

      for (const row of rowCandidates) {
        const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim();

        const match = rowText.match(
          /^([A-Z]*\s?\d+(?:\.\d+)?(?:\s?IT|\s?EU|\s?FR)?|XS|S|M|L|XL|XXL|XXXL|U|OS|UNI|ONE SIZE)\s+(\d+)\s*pc\.?/i
        );

        if (match) {
          variantRows.push({
            supplier_size: match[1].trim(),
            stock_quantity: Number(match[2]),
            raw_text: rowText
          });
        }
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

    const productCode = cleanText(data.product_code);

    if (!productCode) {
      console.log('SKIP CARD WITHOUT PRODUCT CODE:', {
        page: pageNumber,
        index: i + 1,
        brand: data.brand
      });
      continue;
    }

    const retailPrice = toNumber(data.money_matches[0]);
    const finalPrice = toNumber(data.money_matches[data.money_matches.length - 1]);
    const discountPercent = toNumber(data.discount_percent);

    const productKey = `${SUPPLIER_SLUG}:${productCode}`;
    const scannedAt = new Date().toISOString();

    const variantsRaw = data.variant_rows.length
      ? data.variant_rows.map(v => ({
          supplier_size: cleanText(v.supplier_size),
          supplier_sku: `${productCode}${cleanText(v.supplier_size)}`,
          supplier_variant_code: `${productCode}-${cleanText(v.supplier_size)}`,
          stock_quantity: v.stock_quantity,
          is_available: v.stock_quantity > 0,
          supplier_retail_price: retailPrice,
          supplier_final_price: finalPrice,
          supplier_discount_percent: discountPercent,
          currency: 'EUR',
          raw_variant_json: v
        }))
      : [{
          supplier_size: 'U',
          supplier_sku: `${productCode}U`,
          supplier_variant_code: `${productCode}-U`,
          stock_quantity: 1,
          is_available: true,
          supplier_retail_price: retailPrice,
          supplier_final_price: finalPrice,
          supplier_discount_percent: discountPercent,
          currency: 'EUR',
          raw_variant_json: {
            fallback: true,
            reason: 'No listing variant rows found'
          }
        }];

    const imagesRaw = data.image_urls.map((url, index) => ({
      url,
      image_url: url,
      supplier_image_url: url,
      position: index + 1,
      image_position: index + 1,
      type: index === 0 ? 'main' : 'gallery',
      image_type: index === 0 ? 'main' : 'gallery',
      is_main: index === 0,
      raw: url
    }));

    const productHash = makeHash({
      supplier_slug: SUPPLIER_SLUG,
      supplier_product_code: productCode,
      supplier_final_price: finalPrice,
      supplier_retail_price: retailPrice,
      supplier_discount_percent: discountPercent,
      variants: variantsRaw.map(v => ({
        size: v.supplier_size,
        stock: v.stock_quantity,
        available: v.is_available
      })),
      is_active: true
    });

    const product = {
      supplier_name: SUPPLIER_NAME,
      supplier_slug: SUPPLIER_SLUG,

      supplier_sku: productCode,
      supplier_product_code: productCode,

      brand_raw: cleanText(data.brand),
      title_raw: null,
      description_raw: null,

      gender_raw: null,
      category_raw: null,
      subcategory_raw: null,
      type_raw: null,
      color_raw: null,
      season_raw: cleanText(data.season),

      composition_raw: null,
      made_in_raw: null,
      size_and_fit_raw: null,

      supplier_retail_price: retailPrice,
      supplier_final_price: finalPrice,
      supplier_discount_percent: discountPercent,

      currency: 'EUR',
      is_sale: Boolean(discountPercent),

      supplier_product_url: null,
      listing_url: buildPageUrl(pageNumber),

      product_key: productKey,
      product_hash: productHash,
      hash_source: `${SUPPLIER_SLUG}|${productCode}|${finalPrice}|${retailPrice}|${discountPercent}`,

      images_raw: imagesRaw,
      variants_raw: variantsRaw,

      raw_json: {
        source: 'listing_delta_only',
        page_number: pageNumber,
        card_index: i + 1,
        lines: data.lines,
        html: data.html,
        image_urls: data.image_urls,
        variant_rows: data.variant_rows
      },

      scrape_status: 'ingested',
      scan_mode: 'delta',
      scanned_at: scannedAt,
      ingested_at: scannedAt,

      is_active: true,
      is_archived: false
    };

    products.push(product);

    console.log('DELTA PRODUCT OK:', {
      page: pageNumber,
      index: i + 1,
      brand: product.brand_raw,
      code: product.supplier_product_code,
      retail: product.supplier_retail_price,
      final: product.supplier_final_price,
      discount: product.supplier_discount_percent,
      variants: product.variants_raw.length,
      images: product.images_raw.length
    });
  }

  return products;
}

async function sendWebhook(products) {
  if (!process.env.N8N_WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is missing');
  }

  console.log('Sending DELTA webhook to n8n...');

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

  console.log('Webhook status:', response.status);
  console.log('Webhook sent successfully');
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1400
    }
  });

  page.setDefaultTimeout(30000);

  const products = [];

  try {
    await login(page);

    const END_PAGE = START_PAGE + MAX_PAGES - 1;

    for (let currentPage = START_PAGE; currentPage <= END_PAGE; currentPage++) {
      const productCount = await openListing(page, currentPage);

      if (!productCount) {
        console.log('No products found. Stop pagination.');
        break;
      }

      const pageProducts = await collectProductsFromListing(page, currentPage);
      products.push(...pageProducts);

      await page.waitForTimeout(3000);
    }

    console.log('========================');
    console.log('DELTA SCAN FINISHED');
    console.log('Prepared products:', products.length);
    console.log('========================');

    if (!products.length) {
      throw new Error('No products prepared');
    }

    console.log('First product:', {
      brand_raw: products[0].brand_raw,
      supplier_product_code: products[0].supplier_product_code,
      supplier_retail_price: products[0].supplier_retail_price,
      supplier_final_price: products[0].supplier_final_price,
      supplier_discount_percent: products[0].supplier_discount_percent,
      variants_count: products[0].variants_raw.length,
      images_count: products[0].images_raw.length,
      scan_mode: products[0].scan_mode
    });

    await sendWebhook(products);
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error('Fatal error:', error.message);

  if (error.response) {
    console.error('Response status:', error.response.status);
    console.error('Response data:', error.response.data);
  }

  process.exit(1);
});
