# Assisted purchase-invoice sync from the tax portal (issue #325)

The accountant fetches a client's purchase-invoice list for one VAT period, and the invoice XML the portal has, from
hoadondientu.gdt.gov.vn without leaving Crove. The design and its reasons are in
[ADR-0036](../adr/0036-assisted-tax-portal-sync.md); the legal and vendor background is the spike
[tax-portal-invoice-sync.md](../research/tax-portal-invoice-sync.md). The manual Excel import
([tax-portal-invoice-list.md](tax-portal-invoice-list.md)) stays and needs none of this.

## Turning it on

- `TAX_PORTAL_SYNC=true` (default `false`) and a credential key (`CREDENTIAL_KEY` or `CREDENTIAL_KEY_FILE`; the
  all-in-one container creates one). The API refuses to start with the first and without the second.
- The server must reach `https://hoadondientu.gdt.gov.vn` on port 443. Tool builders report that the portal blocks some
  hosts outside Vietnam; host the deployment in Vietnam (backlog decision D3) or keep using the Excel import.
- Firms need the client's written consent to use its portal account (spike section 3 and O1). The screen asks the
  accountant to confirm it before each login and records that in the audit row; it does not replace the agreement.

## Using it

1. On "Đối chiếu cổng thuế", pick the period and click **Lấy danh sách từ cổng thuế** (owners, admins and members of
   the client's org).
2. The user name is the client's tax code (from Settings). Type the client's portal password, the characters of the
   CAPTCHA the portal shows (**Đổi mã khác** fetches another), tick the consent box and click **Đăng nhập và lấy danh
   sách**.
3. Crove logs in, fetches the period's purchase list (a quarter is fetched one month at a time) and files it as a list
   of the period, in place of the period's earlier synced lists. The worker records it within seconds; the
   reconciliation below updates.
4. Crove then downloads the XML of the invoices the portal has a code for and Crove lacks, a few at a time, into the
   Inbox. Keep the page open until it says it is done. Invoices without a tax authority code ("không mã") and cash
   register invoices have no XML on the portal: ask the seller (or use "Đề nghị công ty bổ sung hóa đơn").
5. Running it again for the same period replaces the synced list; an unchanged portal answer files nothing new, and an
   invoice already downloaded for the list is not downloaded again.

Errors are shown in words: wrong CAPTCHA (get a new one), wrong password (check with the client: after 3 wrong
passwords in an hour Crove stops logging in for that client, before the portal locks the account), account locked,
the portal limiting or blocking requests, the portal down, a session expired after 20 minutes.

## What Crove keeps

| Kept | Where |
|---|---|
| The portal's answer to the list queries, as JSON | an import file of the org (source `import`, `application/json`), the list's evidence |
| The list's rows | `crove_finance.portal_invoice_row`, recorded by the worker as for an Excel list |
| Each XML file | an uploaded file of the accountant, read by the worker like any upload |
| Each call to the portal: who, step, outcome class, file id or row count | `crove_kernel.external_call` (target `gdt_einvoice`) and the commands' audit rows |

Never kept: the password, the CAPTCHA answer, the portal's session token, cookies, the login's answer. The token
travels only inside an envelope sealed with the deployment's credential key, held by the browser for one sync.

## The portal's API as Crove calls it

From public open-source tools that call the portal's own web API (spike section 2.2; for example
[INVONESOURCE](https://github.com/cuongccna/INVONESOURCE/blob/main/bot/src/gdt-direct-api.service.ts), read on
2026-10-23). **Not checked against the live portal**: nobody logged in to it while building this, and tests never call
it. The fake portal in `e2e/fake-tax-portal/server.ts` answers these shapes.

| Step | Request | Answer Crove reads |
|---|---|---|
| CAPTCHA | `GET /api/captcha` | `{ key, content }`, `content` an SVG shown to the person as an image |
| Login | `POST /api/security-taxpayer/authenticate` with `{ username, password, cvalue, ckey }` | `{ token }`; a 400 or 401 whose words mention the CAPTCHA is a wrong CAPTCHA, one that says locked is a locked account, any other a wrong password |
| List | `GET /api/query/invoices/purchase?sort=tdlap:desc,khmshdon:asc,shdon:desc&size=50&page=N&search=tdlap=ge=dd/mm/yyyyT00:00:00;tdlap=le=dd/mm/yyyyT23:59:59;ttxly==5` (then `ttxly==6`, `ttxly==8`), and `GET /api/sco-query/invoices/purchase` without `ttxly` | `{ datas or data, total }`; rows with `nbmst`, `nbten`, `nmmst`, `khmshdon`, `khhdon`, `shdon`, `tdlap`, `dvtte`, `tgtcthue`, `tgtthue`, `tgtttbso`, `tthai` |
| XML | `GET /api/query/invoices/export-xml?nbmst&khhdon&shdon&khmshdon` | a ZIP holding the invoice XML (only for `ttxly` 5) |

All requests after the login carry `Authorization: Bearer <token>`. `tdlap` comes as an ISO instant in UTC, as epoch
milliseconds on the cash register endpoint, or as `dd/mm/yyyy`; Crove reads the date in Vietnam's time zone. `tthai` 1
to 6 are the states the Excel export words ("Hóa đơn mới" to "Hóa đơn đã bị hủy").

Open points for the supervised trial (owner and the partner's accountant, #61):

- Whether the 2026 redesign kept these paths under `/api` on port 443, and whether the September 2026 change added a
  request header Crove does not send (tool authors mention "a new request identifier").
- How long the token lasts (Crove assumes at most 20 minutes and asks for a new login after).
- The refusal words of the login (wrong CAPTCHA, wrong password, locked), and the block page the WAF serves.
- Whether the cash register endpoint needs a `ttxly` filter.

When a point turns out wrong, the client (`apps/kernel/src/tax-portal.ts`) and the fake portal change together.
