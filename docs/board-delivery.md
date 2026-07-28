# Board delivery — the second artifact

In the card-structure redesign the game board stops being a page inside the deck
and becomes its own output file. An order therefore delivers **two** artifacts:

| artifact  | file                                        | route                                                                      |
| --------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| card deck | `GENERATED_DIR/<collection id>.pdf`         | `/api/admin/collections/:id/pdf`, `/api/collections/:id/pdf?t=<token>`     |
| board     | `GENERATED_DIR/<collection id>-board.<ext>` | `/api/admin/collections/:id/board`, `/api/collections/:id/board?t=<token>` |

## Generator contract

`generator/order_to_pdf.py` writes the board **next to the deck**, using the deck
path's stem plus `-board`:

```
out_pdf            .../generated/<collection id>.pdf
board (expected)   .../generated/<collection id>-board.pdf
```

The server resolves the board by probing that stem in its own `GENERATED_DIR`
(`.pdf`, then `.png`, then `.svg` — see `boardFileFor` in `server/index.js`). It
deliberately does **not** read the path off the generator's stdout: a path handed
over by a subprocess must never decide which file a download route serves. So the
generator needs no new stdout line — writing the file at the agreed path is the
whole contract. Only the extension is negotiable; the stem is not.

A run that produces no board is not an error. `production.board_file` stays
`null`, the email keeps its single download button, the admin row shows only the
PDF, and both board routes 404. That is the state of every order generated before
the split and of any theme not yet migrated to the new card structure.

## Delivery

- `production.board_file` (basename, or `null`) records whether an order has one.
- The board reuses the order's existing `production.pdf_token` — one order, one
  secret, two artifacts. No second capability token is minted.
- `sendPdfReady(collection, baseUrl, links)` takes
  `{ admin, customer, adminBoard, customerBoard }`. Each recipient's message is
  built from only their own pair, so the admin-keyed URLs can never appear in the
  customer's copy.
- The board CTA label is owner-editable: `cta_labels.downloadBoard` in
  `server/settings.js`, exposed on `admin-texts.html`.
