# FIRST TRACK KHATANEX — Backend

Node.js + Express + MySQL backend for a digital ledger / business accounting app.
This is the **v3** backend: role model changed to `user / employee / superadmin`,
almost nothing is mandatory anywhere, and billing documents now cover Invoice,
Quotation, and Merchant Bill.

## 1. Setup

```bash
npm install
cp .env.example .env      # then fill in your real DB password, JWT secret, etc.
mysql -u root -p < db/schema.sql
npm run seed:superadmin   # creates the ONE super admin, from SUPERADMIN_* in .env
npm run dev                # or: npm start
```

Server runs on `http://localhost:5000` by default. All endpoints are prefixed `/api`.

**Already have a database from an earlier version?** Don't re-run `schema.sql` —
run `db/migration_003_roles_and_optional_fields.sql` instead (and
`db/migration_002_new_features.sql` first, if you're coming from the very first
version). Each migration file's header comment says exactly when to use it.

## 2. Roles

- **user** — self-registers via `POST /api/auth/register`. Uses the normal
  operational dashboard (customers, khata, payments, invoices, inventory, etc).
- **employee** — created **directly by the super admin** with
  `POST /api/superadmin/employees` (name, email, password, an
  `employee_role_type` label like `"accountant"` — all optional except
  email+password, which are needed for any login to work at all). The
  employee never self-registers and never sees the super admin's own
  credentials — the super admin assigns login credentials directly. Uses the
  same operational dashboard as a `user`.
- **superadmin** — exactly one account, created only via
  `npm run seed:superadmin` (never through a public route). Sees the overview
  dashboard and manages employees.

Everyone logs in through the same `POST /api/auth/login` — the response's
`role` field tells the frontend which dashboard to send them to.

## 3. Nothing is mandatory

Every create/update endpoint accepts a blank or partial submission. Sensible
defaults fill in the gaps (an unnamed customer becomes "Unnamed Customer", an
amount left blank becomes 0, a payment type left unset becomes "cash", a
vehicle number left blank is just `null`, and so on). This was a deliberate
choice — see each controller's top comment for exactly what defaults to what.
The only true exception is authentication: `email` + `password` are still
needed to register/log in/create an employee, because there is no functional
way to issue a login without them.

## 4. Auth

All protected routes need: `Authorization: Bearer <token>` (token returned by
register/login).

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | /api/auth/register | public | create a normal `user` account |
| POST | /api/auth/login | public | login (any role), get JWT |
| GET | /api/auth/me | any logged-in | current profile |
| PATCH | /api/auth/me | any logged-in | update own name/phone/business_name/address |

## 5. Super admin — employee management

| Method | Route | Purpose |
|---|---|---|
| GET | /api/superadmin/users | overview of every account (users + employees) |
| GET | /api/superadmin/users/:id | one account's detail |
| PATCH | /api/superadmin/users/:id/status | `{ status: "active"\|"inactive" }` — works on any account |
| POST | /api/superadmin/employees | `{ name, email, password, phone, employee_role_type }` — creates an employee login |
| GET | /api/superadmin/employees | list all employees |
| PATCH | /api/superadmin/employees/:id | edit an employee's name/phone/role-type label |

There is no "promote a user to admin" flow in this version — employees are
always created directly by the super admin with credentials the super admin
chooses.

## 6. Customers

| Method | Route | Purpose |
|---|---|---|
| POST | /api/customers | `{ name, phone, email }` — all optional |
| GET | /api/customers?search= | list, sorted by highest due first |
| GET | /api/customers/:id | profile: due amount + full sale/payment history |
| PATCH | /api/customers/:id | edit name/phone/email |

## 7. Khata (unified ledger)

| Method | Route | Purpose |
|---|---|---|
| GET | /api/khata?customer_id=&from=&to= | merged, chronological feed of sales + payments |

The frontend's Khata page expects one combined ledger of credit/debit entries.
The backend actually stores sales (`collections`) and payments (`payments`)
separately, so this endpoint merges both into the shape the frontend already
expects: `{ id, name, description, amount, type: "credit"|"debit", date }`.
Convention used: any sale and any money **received** (due payments, investor
advances) is `"credit"`; money the business **pays out** is `"debit"`.

## 8. Collections (add-sale feature)

| Method | Route | Purpose |
|---|---|---|
| POST | /api/collections | add a sale — everything optional, see body shape below |
| GET | /api/collections?from=&to=&payment_type= | list (filters optional) |
| GET | /api/collections/summary?user_id= | today / this_week / this_month, split cash vs online vs due |

Body for `POST /api/collections` (all fields optional):
```json
{
  "item_name": "2 packets of rice",
  "amount": 500,
  "payment_type": "due",
  "customer_id": 3,
  "customer_name": "Ramesh",
  "customer_phone": "9800000000",
  "sale_date": "2026-08-17"
}
```

## 9. Payments (dues paid / paid by business / investor advance)

| Method | Route | Purpose |
|---|---|---|
| POST | /api/payments | see `payment_category` below — everything optional |
| GET | /api/payments?category= | list, filter by category |

`payment_category`: `due_received` / `paid_by_business` / `advance_from_investor`
(defaults to `due_received` if omitted).

## 10. Stock / Inventory (with HSN auto-fill)

| Method | Route | Purpose |
|---|---|---|
| POST | /api/stock | `{ product_name, category, type, hsn_code, price, quantity }` — all optional |
| GET | /api/stock?sortBy=name\|type\|price\|category&order=asc\|desc&search= | list, sortable |
| PATCH | /api/stock/:id | edit |
| DELETE | /api/stock/:id | remove |

If `hsn_code` is given and `price`/`quantity` are left blank, they're
auto-filled from your own latest recorded purchase invoice at that HSN code
(see below) — otherwise they just default to 0.

### Purchase invoices (seller invoices, keyed by HSN code)

| Method | Route | Purpose |
|---|---|---|
| POST | /api/purchase-invoices | multipart form, all fields optional, optional file `invoice_file` |
| GET | /api/purchase-invoices?hsn_code=&seller_name= | list recorded purchase invoices |
| GET | /api/purchase-invoices/lookup?hsn_code= | latest match for a given HSN code (used for autofill) |

## 11. Billing documents — Invoice, Quotation, Merchant Bill

One shared endpoint and table for all three document types.

| Method | Route | Purpose |
|---|---|---|
| POST | /api/documents | `{ doc_type, customer_id, items }` — everything optional |
| GET | /api/documents?doc_type=&customer_id=&from=&to= | list |
| GET | /api/documents/:id | one document + its line items |
| POST | /api/documents/:id/resend-email | re-attempt emailing the same PDF |

`doc_type`: `invoice` (default) / `quotation` / `merchant_bill` — decides the
number prefix (`INV-`/`QUO-`/`BILL-`) and the PDF title; everything else is
shared logic. `customer_id` may be omitted entirely (renders as "Walk-in
Customer" on the PDF), and `items` may be an empty array (totals come out to
0). The date is always the current server time — never taken from the client.

The PDF is generated with your brand logo/name/address (see Settings below),
saved under `/uploads/invoices/`, and a direct download URL is returned. If
the customer has an `email` on file, it's automatically emailed via SMTP —
this never blocks document creation if it fails; `email_status` on the
document record shows `sent`/`failed`/`not_sent`.

## 12. Settings (brand logo, company name/address/GSTIN — used on all PDFs)

| Method | Route | Purpose |
|---|---|---|
| GET | /api/settings | current company info + logo path |
| PATCH | /api/settings | employee/superadmin — `{ company_name, address, gstin }` |
| POST | /api/settings/logo | employee/superadmin — multipart file field `logo` |

## 13. Vehicles / Way Bills

Two flows, one endpoint (`trip_type` decides which). Nothing is required —
vehicle number, driver name/phone, and both photo fields can all be left
blank; you can fill them in later via the same trip record if needed.

**`outgoing`** — you're sending a truck: you generate the way bill yourself.
**`incoming`** — you're the buyer: the seller already generated a way bill and
sent it to you (e.g. over WhatsApp); you just upload their copy here.

| Method | Route | Purpose |
|---|---|---|
| POST | /api/vehicles | create a trip |
| GET | /api/vehicles?trip_type=&status=&vehicle_number= | list |
| GET | /api/vehicles/:id | one trip's full detail |
| PATCH | /api/vehicles/:id/start-trip | stamps journey start time = now |
| PATCH | /api/vehicles/:id/reached | stamps journey end time = now, optional `unloading_photo` file |

`POST /api/vehicles` is `multipart/form-data`. Optional file field
`loading_photo` for outgoing trips (auto-generates a way bill PDF regardless
of how much else was filled in); optional file field `waybill_file` for
incoming trips (stores whatever was uploaded).

## 14. Reports (employee/superadmin only)

| Method | Route | Purpose |
|---|---|---|
| GET | /api/reports/profit-loss?user_id=&from=&to= | profit/loss breakdown (user_id optional — all users if omitted) |
| GET | /api/reports/monthly-trend?months=6&user_id= | monthly sales vs expenses, for charting |

## 15. Environment variables

See `.env.example` for the full list: DB connection, `JWT_SECRET`,
`SUPERADMIN_*` (seed script only), `BASE_URL`, `FRONTEND_URL` (informational
— CORS is left open for now, per current requirements), SMTP settings for
auto-emailing documents, and default company info.

## 16. Notes for the frontend integration

- All list endpoints return `{ success, count, <resource>: [...] }`.
- All single-item endpoints return `{ success, <resource>: {...} }`.
- Errors return `{ success: false, message }` with an appropriate HTTP status.
- A plain `user` role only ever sees/affects their **own** collections,
  expenses, payments, and vehicle trips; `employee`/`superadmin` can see
  everyone's (pass `?user_id=` / `?created_by=` where supported, or omit it
  to see all).
- CORS is currently wide open (`cors()` with no restrictions) since security
  hardening was explicitly deferred — tighten it in `server.js` once you have
  a stable production frontend URL.
