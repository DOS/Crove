# Runbook: the AI extraction eval

How Ludy measures how well it reads invoices (backlog item M2-11, issues #153 and #687). Ludy reads three kinds of documents: e-invoice XML, PDF and photos.
- An **e-invoice XML** goes through a parser. No AI is involved, so every amount must be exact.
- A **PDF** has its text layer read, and the AI turns that text into fields.
- A **photo** (JPG, PNG, WEBP) goes to the AI directly.

The eval runs each document of a set through that same path and compares the result with the answer a person wrote down. It reports:
- accuracy per kind (XML, PDF, photo) and per field (seller tax code, total, line amounts, and so on);
- the five most frequent errors;
- a gate that fails when any amount of any XML document is wrong.

PDF and photo accuracy is measured, not gated: fixing the top errors is tracked on #153.

Run it before a change of AI model, endpoint or prompt.

## Before you start

| Input | Who | Issue |
|---|---|---|
| About 100 real documents, with the consent of the businesses they come from | owner | #304 |
| The expected answer of each document, checked by a person (the pilot partner's accountant can confirm amounts) | owner, accountant | #304, #61 |
| The AI endpoint for PDFs and photos | owner | #312 |
| A private machine to run it on, which may hold the documents (the pilot server or the owner's computer) | owner | |

## 1. Where the documents go

The real documents never go into the repository, a pull request, an issue or a CI log. GitHub is public.

1. Put them in one folder outside your checkout of this repository, for example `/srv/crove-eval/` on the pilot server. Subfolders are fine, for example `xml/`, `pdf/` and `photo/`.
2. Next to each document, put a file with the same name ending in `.json` that holds its expected answer, for example `hd-0001.pdf` and `hd-0001.json`.
3. Accepted documents: `.xml`, `.pdf`, `.jpg`, `.jpeg`, `.png`, `.webp`.

The eval refuses to start when a document has no answer or an answer has no document, and names the files.

The expected answer has the same shape as the committed samples in [packages/agent/test/fixtures/documents](https://github.com/DOS/Crove/tree/main/packages/agent/test/fixtures/documents):
- `description`: one line on what the document is;
- `expected`: the invoice as printed. That means the series (ký hiệu), number, date (`YYYY-MM-DD`), currency, seller and buyer (name and tax code), every goods or service line in printed order (description, quantity, unit price, amount before VAT, VAT rate, and `"discount": true` for a trade discount), the subtotal, the VAT and the total;
- `expected` is `null` for a document that is not a purchase invoice, such as a quotation.

Amounts are plain digits, with no thousands separators: `1815000`, not `1.815.000`. Note lines of an e-invoice (for example "Ghi chú: ...") are left out, as Ludy does not book them.

## 2. Run it

On the private machine, in a checkout of this repository with Node 26 and pnpm (`pnpm install` once):

```sh
AI_EVAL_DIR=/srv/crove-eval \
AI_BASE_URL=<the endpoint> AI_MODEL=<the model> AI_API_KEY=<the key, if any> \
pnpm ai:eval:documents
```

- These are the same `AI_*` variables the server uses. Without `AI_BASE_URL` and `AI_MODEL`, only the XML documents run, since they need no AI.
- The report names documents and fields but never prints their content, so it is safe to paste into an issue. To see the expected and returned values on your own screen, add `AI_EVAL_SHOW_VALUES=true`, and never paste that output anywhere public.
- Without `AI_EVAL_DIR`, the eval scores the committed synthetic set: one XML, one PDF and one photo, with fake tax codes.

## 3. Read the result

- **Kind table:** field accuracy for XML, PDF and photos.
- **Field table:** accuracy of each field across all documents. Lines are counted together, for example `lines[].amount`.
- **Top errors:** the five most frequent wrong fields by kind. `extraction` means the path could not read the document at all, for example a scanned PDF without text, or an amount the AI wrote in an unreadable format.
- **Gate:** `PASS` when every XML amount is exact. A `FAIL` names the XML documents and fields; it is a bug in the XML parser, to fix before anything else.

Post the summary on #153, which tracks fixing the top errors.

## 4. In GitHub Actions

The workflow [ai-eval.yml](https://github.com/DOS/Crove/blob/main/.github/workflows/ai-eval.yml) runs on demand (Actions, "ai-eval", "Run workflow") and on every pull request that changes `packages/agent/src`. It scores only the committed synthetic set: the document eval and the older text eval (`pnpm ai:eval`).

It needs the repository secrets `AI_BASE_URL` and `AI_MODEL`, plus `AI_API_KEY` if the endpoint asks for one (owner action, #312). Without them, and on pull requests from forks (which never get secrets), the job passes with the notice "AI eval skipped" and runs nothing.
