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

  const number = Number(s);
  return Number.isFinite(number) ? number : null;
}

function makeHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

async function openListing(page, pageNumber = 1) {
  const pageUrl = pageNumber > 1 ? `${LISTING_URL}?page=${pageNumber}` : LISTING_URL;

  console.log('Opening listing URL:', pageUrl);

  await page.goto(pageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  await page.waitForTimeout(15000);

  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1000);
  }

  const productCount = await page.locator('.product-miniature').count();

  console.log('Listing opened');
  console.log('Current listing URL:', page.url());
  console.log('Products found on page:', productCount);

  return productCount;
}

async function collectDeltaCards(page, pageNumber) {
  const cards = [];
  const productCards = page.locator('.product-miniature');
  const count = await productCards.count();
  const limit = Math.min(count, LIMIT_PRODUCTS);

  console.log('Listing cards to collect:', limit);

  for (let i = 0; i < limit; i++) {
    const card = productCards.nth(i);

    const data = await card.evaluate(el => {
      const text = el.innerText || '';
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
        .filter(Boolean);

      const moneyMatches = text.match(/€\s?[\d.,]+/g) || [];
      const discountMatch = text.match(/-\s?\d+%/);

      const productCodeLine = lines.find(line => {
        const normalized = line.trim();
        const brandLine = lines[0] ? lines[0].trim().toUpperCase() : '';

        return (
          normalized.toUpperCase() !== brandLine &&
          /^[A-Z0-9\-]{6,}$/i.test(normalized) &&
          /\d/.test(normalized) &&
          !normalized.includes('€') &&
          !normalized.includes('%')
        );
      });

      const variantRows = [];

      const rowCandidates = Array.from(el.querySelectorAll('tr, .row, li, div'));

      for (const row of rowCandidates) {
        const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim();

        const match = rowText.match(/^([A-Z]*\s?\d+(?:\.\d+)?|XS|S|M|L|XL|XXL|U)\s+(\d+)\s*pc\.?/i);

        if (match) {
          variantRows.push({
            size: match[1].trim(),
            stock_quantity: Number(match[2]),
            raw_text: rowText
          });
        }
      }

      return {
        lines,
        image_urls: imageUrls,
        money_matches: moneyMatches,
        discount: discountMatch ? discountMatch[0] : null,
        product_code_line: productCodeLine,
        variant_rows: variantRows
      };
    });

    const brand = data.lines[0] || null;
    const productCode = data.product_code_line || null;

    const retailPrice = data.money_matches[0] || null;
    const finalPrice = data.money_matches[data.money_matches.length - 1] || null;

    if (!productCode) {
      console.log('CARD SKIPPED - no product code:', {
        page: pageNumber,
        index: i + 1,
        brand,
        lines: data.lines.slice(0, 8)
      });
      continue;
    }

    const variants = [];

    if (data.variant_rows.length) {
      for (const item of data.variant_rows) {
        const size = cleanText(item.size || 'U');
        const stockQty = toNumber(item.stock_quantity) ?? 0;

        variants.push({
          supplier_name: SUPPLIER_NAME,
          supplier_slug: SUPPLIER_SLUG,
          supplier_product_code: productCode,
          supplier_sku: cleanText(`${productCode}${size}`),
          supplier_variant_code: cleanText(`${productCode}-${size}`),
          supplier_size: size,
          stock_quantity: stockQty,
          is_available: stockQty > 0,
          currency: 'EUR',
          scan_mode: 'delta',
          scanned_at: new Date().toISOString(),
          raw_variant_json: item
        });
      }
    } else {
      variants.push({
        supplier_name: SUPPLIER_NAME,
        supplier_slug: SUPPLIER_SLUG,
        supplier_product_code: productCode,
        supplier_sku: cleanText(`${productCode}U`),
        supplier_variant_code: cleanText(`${productCode}-U`),
        supplier_size: 'U',
        stock_quantity: 1,
        is_available: true,
        currency: 'EUR',
        scan_mode: 'delta',
        scanned_at: new Date().toISOString(),
        raw_variant_json: {
          source: 'delta_listing_fallback'
        }
      });
    }

    const product = {
      supplier_name: SUPPLIER_NAME,
      supplier_slug: SUPPLIER_SLUG,

      supplier_sku: cleanText(productCode),
      supplier_product_code: productCode,

      brand_raw: cleanText(brand),
      title_raw: null,
      description_raw: null,

      supplier_retail_price: toNumber(retailPrice),
      supplier_final_price: toNumber(finalPrice),
      supplier_discount_percent: toNumber(data.discount),

      currency: 'EUR',
      is_sale: Boolean(data.discount),

      supplier_product_url: null,
      listing_url: pageNumber > 1 ? `${LISTING_URL}?page=${pageNumber}` : LISTING_URL,

      product_key: `${SUPPLIER_SLUG}:${productCode}`,
      product_hash: makeHash({
        supplier_slug: SUPPLIER_SLUG,
        supplier_product_code: productCode,
        supplier_final_price: toNumber(finalPrice),
        supplier_discount_percent: toNumber(data.discount),
        variants
      }),

      images_raw: [],
      variants_raw: variants,

      raw_json: {
        source: 'delta_listing',
        page_number: pageNumber,
        card_index: i,
        lines: data.lines,
        image_urls: data.image_urls,
        money_matches: data.money_matches,
        discount: data.discount,
        variant_rows: data.variant_rows
      },

      scrape_status: 'delta',
      scan_mode: 'delta',
      scanned_at: new Date().toISOString(),
      scraped_at: new Date().toISOString(),

      is_active: true,
      is_archived: false
    };

    cards.push(product);

    console.log('DELTA CARD OK:', {
      page: pageNumber,
      index: i + 1,
      brand,
      product_code: productCode,
      retail_price: product.supplier_retail_price,
      final_price: product.supplier_final_price,
      discount: product.supplier_discount_percent,
      variants: variants.length
    });
  }

  return cards;
}

async function sendWebhook(products) {
  if (!process.env.N8N_DELTA_WEBHOOK_URL && !process.env.N8N_WEBHOOK_URL) {
    throw new Error('N8N_DELTA_WEBHOOK_URL or N8N_WEBHOOK_URL is missing');
  }

  const webhookUrl = process.env.N8N_DELTA_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;

  console.log('Sending DELTA webhook to n8n...');

  const response = await axios.post(
    webhookUrl,
    {
      supplier_name: SUPPLIER_NAME,
      supplier_slug: SUPPLIER_SLUG,
      source: 'julian_delta_listing_scan',
      scan_mode: 'delta',
      scanned_at: new Date().toISOString(),
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
      height: 1200
    }
  });

  page.setDefaultTimeout(30000);

  const products = [];

  try {
    await login(page);

    const END_PAGE = START_PAGE + MAX_PAGES - 1;

    console.log('DELTA SCAN SETTINGS:', {
      START_PAGE,
      END_PAGE,
      MAX_PAGES,
      LIMIT_PRODUCTS
    });

    for (let currentPage = START_PAGE; currentPage <= END_PAGE; currentPage++) {
      console.log('========================');
      console.log('DELTA PAGE:', currentPage);
      console.log('========================');

      const productCount = await openListing(page, currentPage);

      if (!productCount) {
        console.log('No products found. Stop pagination.');
        break;
      }

      const pageProducts = await collectDeltaCards(page, currentPage);
      products.push(...pageProducts);

      console.log('PAGE DONE:', {
        page: currentPage,
        products_collected: pageProducts.length,
        total_products: products.length
      });

      await page.waitForTimeout(3000);
    }

    console.log('Prepared delta products:', products.length);

    if (!products.length) {
      throw new Error('No delta products prepared');
    }

    console.log('First delta product:', {
      supplier_product_code: products[0].supplier_product_code,
      brand_raw: products[0].brand_raw,
      supplier_retail_price: products[0].supplier_retail_price,
      supplier_final_price: products[0].supplier_final_price,
      supplier_discount_percent: products[0].supplier_discount_percent,
      variants_count: products[0].variants_raw.length,
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
