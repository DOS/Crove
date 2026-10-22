// A fake of the tax portal's lookup API (hoadondientu.gdt.gov.vn/api) for Crove's tests (issue #325). It answers the
// endpoints the assisted sync calls with the shapes public tools record (docs/integrations/tax-portal-sync.md), from a
// small synthetic data set: no real taxpayer, no real portal, no network. Used by the kernel's unit and database tests
// in-process, and by the end-to-end tests as a compose service (`node main.ts`, Node's type stripping: node: imports
// and erasable syntax only).
//
// - GET  /api/captcha                          { key, content: <svg> } showing the answer in plain text
// - POST /api/security-taxpayer/authenticate   { username, password, cvalue, ckey } -> { token } or a 400 refusal
// - GET  /api/query/invoices/purchase          ?search=tdlap=ge=..;tdlap=le=..;ttxly==N &size &page -> { datas, total }
// - GET  /api/sco-query/invoices/purchase      the cash register invoices, dates as epoch milliseconds
// - GET  /api/query/invoices/export-xml        ?nbmst&khhdon&shdon&khmshdon -> a ZIP holding invoice.xml
//
// Every invoice names the logged-in tax code as the buyer, so any test org with a tax code can sync from it.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { crc32 } from 'node:zlib';

export interface FakePortalOptions {
  port?: number;
  host?: string;
  captchaAnswer?: string;
  password?: string;
  // Answer every request (or only those to `path`) with this status: a portal that rate limits, blocks or is down.
  outage?: { status: number; body: string; contentType: string; path?: string } | null;
}

export interface FakePortalState {
  logins: Array<{ username: string; ok: boolean }>;
  // Every request: method, path and whether it carried a body (never the body itself).
  requests: Array<{ method: string; path: string }>;
  xmlDownloads: number;
  // Bodies seen on the login endpoint, kept so a test can check what reached the portal.
  loginBodies: string[];
  // The session tokens handed out, so a test can look for them where they must never be.
  tokens: string[];
}

export interface FakePortal {
  url: string;
  state: FakePortalState;
  options: FakePortalOptions;
  close(): Promise<void>;
}

export const FAKE_CAPTCHA_ANSWER = '3K7QX';
export const FAKE_PORTAL_PASSWORD = 'fake-portal-password-325';

// The synthetic sellers (the e-invoice fixture's seller and two more), with checksum-invalid codes on purpose.
const SELLERS = {
  a: { taxCode: '0101234564', name: 'CÔNG TY TNHH DỊCH VỤ MẪU' },
  b: { taxCode: '0100109107', name: 'CÔNG TY CỔ PHẦN VẬT TƯ MẪU' },
  c: { taxCode: '0312345670', name: 'CỬA HÀNG BÁN LẺ MẪU' },
};

interface FakeInvoice {
  query: 'purchase_5' | 'purchase_6' | 'purchase_8' | 'sco';
  seller: { taxCode: string; name: string };
  series: string;
  number: number;
  day: number;
}

// Per month asked: three invoices with a tax authority code, one without, one from a cash register.
const INVOICES: FakeInvoice[] = [
  { query: 'purchase_5', seller: SELLERS.a, series: 'C26TAB', number: 9101, day: 3 },
  { query: 'purchase_5', seller: SELLERS.a, series: 'C26TAB', number: 9102, day: 5 },
  { query: 'purchase_5', seller: SELLERS.b, series: 'C26TBB', number: 77, day: 9 },
  { query: 'purchase_6', seller: SELLERS.b, series: 'K26TBB', number: 78, day: 12 },
  { query: 'sco', seller: SELLERS.c, series: 'C26MCC', number: 501, day: 20 },
];

const pad = (n: number) => String(n).padStart(2, '0');

function invoiceXml(inv: FakeInvoice, date: string, buyer: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon Id="data">
    <TTChung><PBan>2.1.0</PBan><THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon><KHMSHDon>1</KHMSHDon><KHHDon>${inv.series}</KHHDon><SHDon>${inv.number}</SHDon><NLap>${date}</NLap><DVTTe>VND</DVTTe><TGia>1</TGia><HTTToan>TM/CK</HTTToan></TTChung>
    <NDHDon>
      <NBan><Ten>${inv.seller.name}</Ten><MST>${inv.seller.taxCode}</MST><DChi>1 Đường Mẫu, Hà Nội</DChi></NBan>
      <NMua><Ten>CÔNG TY NGƯỜI MUA</Ten><MST>${buyer}</MST><DChi>2 Đường Thử, TP Hồ Chí Minh</DChi></NMua>
      <DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><THHDVu>Dịch vụ mẫu</THHDVu><DVTinh>Gói</DVTinh><SLuong>1</SLuong><DGia>1800000</DGia><ThTien>1800000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu>
      <TToan><THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>1800000</ThTien><TThue>180000</TThue></LTSuat></THTTLTSuat><TgTCThue>1800000</TgTCThue><TgTThue>180000</TgTThue><TgTTTBSo>1980000</TgTTTBSo><TgTTTBChu>Một triệu chín trăm tám mươi nghìn đồng</TgTTTBChu></TToan>
    </NDHDon>
  </DLHDon>
  <MCCQT Id="tax">M2-26-FAKE0-${String(inv.number).padStart(11, '0')}</MCCQT>
  <DSCKS><NBan><Signature>stub</Signature></NBan></DSCKS>
</HDon>
`;
}

// A ZIP with one stored (uncompressed) entry, as the portal's XML download is a ZIP.
export function storedZip(name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

// dd/mm/yyyy -> [year, month].
function monthOf(search: string): { year: number; month: number } | null {
  const m = /tdlap=ge=(\d{2})\/(\d{2})\/(\d{4})/.exec(search);
  return m ? { year: Number(m[3]), month: Number(m[2]) } : null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startFakeTaxPortal(options: FakePortalOptions = {}): Promise<FakePortal> {
  const answer = options.captchaAnswer ?? FAKE_CAPTCHA_ANSWER;
  const password = options.password ?? FAKE_PORTAL_PASSWORD;
  const captchas = new Set<string>();
  const tokens = new Map<string, string>();
  const state: FakePortalState = { logins: [], requests: [], xmlDownloads: 0, loginBodies: [], tokens: [] };
  // The month of the last list query: the XML downloads that follow are dated in it.
  let lastMonth = { year: 2026, month: 9 };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    state.requests.push({ method: req.method ?? 'GET', path: url.pathname });
    if (options.outage && (!options.outage.path || options.outage.path === url.pathname)) {
      res.writeHead(options.outage.status, { 'content-type': options.outage.contentType });
      res.end(options.outage.body);
      return;
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/captcha') {
      const key = randomUUID().replace(/-/g, '');
      captchas.add(key);
      const content = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50" viewBox="0,0,200,50"><rect width="200" height="50" fill="#fff"/><text x="30" y="34" font-size="28" font-family="monospace" fill="#222">${answer}</text></svg>`;
      return json(res, 200, { key, content });
    }
    if (req.method === 'POST' && url.pathname === '/api/security-taxpayer/authenticate') {
      const raw = await readBody(req);
      state.loginBodies.push(raw);
      const body = JSON.parse(raw) as { username?: string; password?: string; cvalue?: string; ckey?: string };
      const known = typeof body.ckey === 'string' && captchas.delete(body.ckey);
      if (!known || body.cvalue !== answer) {
        state.logins.push({ username: String(body.username), ok: false });
        return json(res, 400, { message: 'Mã captcha không đúng.' });
      }
      if (body.password !== password) {
        state.logins.push({ username: String(body.username), ok: false });
        return json(res, 400, { message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
      }
      const token = `fake.${randomUUID().replace(/-/g, '')}.${randomUUID().replace(/-/g, '')}`;
      tokens.set(token, String(body.username));
      state.tokens.push(token);
      state.logins.push({ username: String(body.username), ok: true });
      return json(res, 200, { token });
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const buyer = auth ? tokens.get(auth) : undefined;
    if (!buyer) return json(res, 401, { message: 'Unauthorized' });
    const sco = url.pathname === '/api/sco-query/invoices/purchase';
    if (req.method === 'GET' && (url.pathname === '/api/query/invoices/purchase' || sco)) {
      // The search is sent unencoded, as the portal's own app sends it.
      const search = decodeURIComponent(/[?&]search=([^&]*)/.exec(req.url ?? '')?.[1] ?? '');
      const month = monthOf(search);
      if (month) lastMonth = month;
      const ttxly = /ttxly==(\d+)/.exec(search)?.[1];
      const query = sco ? 'sco' : `purchase_${ttxly ?? ''}`;
      const size = Number(url.searchParams.get('size') ?? 50);
      const page = Number(url.searchParams.get('page') ?? 0);
      const rows = month
        ? INVOICES.filter((inv) => inv.query === query).map((inv) => {
            const date = `${month.year}-${pad(month.month)}-${pad(inv.day)}`;
            const instant = Date.parse(`${date}T00:00:00+07:00`);
            return {
              nbmst: inv.seller.taxCode,
              nbten: inv.seller.name,
              nmmst: buyer,
              khmshdon: 1,
              khhdon: inv.series,
              shdon: inv.number,
              // The cash register endpoint sends epoch milliseconds, the other an ISO instant in UTC.
              tdlap: sco ? instant : new Date(instant).toISOString(),
              dvtte: 'VND',
              tgtcthue: 1800000,
              tgtthue: 180000,
              tgtttbso: 1980000,
              tthai: 1,
              ttxly: sco ? 8 : Number(ttxly),
            };
          })
        : [];
      return json(res, 200, { datas: rows.slice(page * size, page * size + size), total: rows.length, state: null });
    }
    if (req.method === 'GET' && url.pathname === '/api/query/invoices/export-xml') {
      const inv = INVOICES.find((i) => i.seller.taxCode === url.searchParams.get('nbmst') && i.series === url.searchParams.get('khhdon') && String(i.number) === url.searchParams.get('shdon'));
      if (!inv || inv.query !== 'purchase_5') return json(res, 500, { message: 'Không tìm thấy hóa đơn' });
      state.xmlDownloads += 1;
      const date = `${lastMonth.year}-${pad(lastMonth.month)}-${pad(inv.day)}`;
      const zip = storedZip('invoice.xml', Buffer.from(invoiceXml(inv, date, buyer), 'utf8'));
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(zip);
      return;
    }
    json(res, 404, { message: 'Not found' });
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://${options.host ?? '127.0.0.1'}:${port}/api`,
        state,
        options,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
