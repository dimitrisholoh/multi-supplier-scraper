const http = require('http');

const PORT = process.env.PORT || 3000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        service: 'julian_full_worker'
      }));
    }

    if (req.method === 'POST' && req.url === '/enrich') {
      const payload = await readJsonBody(req);

      console.log('JULIAN FULL ENRICHMENT REQUEST:', {
        raw_product_id: payload.id || payload.raw_product_id,
        supplier_product_code: payload.supplier_product_code,
        supplier_slug: payload.supplier_slug,
        supplier_product_url: payload.supplier_product_url
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        message: 'Julian full enrichment request received',
        received: {
          raw_product_id: payload.id || payload.raw_product_id,
          supplier_product_code: payload.supplier_product_code
        }
      }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (error) {
    console.error('Worker error:', error.message);

    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: false,
      error: error.message
    }));
  }
});

server.listen(PORT, () => {
  console.log(`Julian full enrichment worker listening on port ${PORT}`);
});
