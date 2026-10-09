# Draft email to Unite (copy, edit, send)

**Subject:** Al Das Medical: new integration for the Finance API (credentials, field list, re-queue)

Hello,

We are building an in-house platform that will read invoices through the Finance API (`GetFinanceDetails`), in addition to our existing integrations. Because the API delivers each record once, we want to start carefully. Could you help with the following?

**Credentials and tokens**

1. Please issue a **separate app_id / app_key** (and a separate refresh pair, if the flow needs two) for the new platform, so it does not share a token with our existing integrations.
2. Is a token valid per credential pair, or global across all credentials for our account? If our platform calls `authorize` or `refreshtoken`, can that invalidate a token currently held by another integration?
3. What is the lifetime of `access_token`: is `expires_in: 240` seconds or minutes? Is the refresh token long-lived?
4. How does a client obtain its **very first** token for a new credential pair (call `authorize` with no bearer token, or do you issue a starting token)?

**Finance data** 5. Please send the **field list and enumerations** for `GetFinanceDetails` (invoice, `ItemsDetails`, `PaymentDetails`): names, types, date formats, and the values of `RefType`, `InvType`, `ItemType`, `PaymentMode`, plus a sample response with test data. 6. Is there an **invoice line ID** and a **last-modified timestamp**? If not, can they be added? 7. Which fields carry the **payer / TPA / member / claim** reference for insurance invoices? 8. What does a successful response look like (`MessageStatus`, `DetailMessage`), and what do the error responses look like? Are errors always HTTP 200? 9. Can the same invoice appear twice in one response? In what order are records returned? 10. Is `AppointmentId` identical to the `appointmentid` returned by the Appointments API, and empty only for invoices with no appointment?

**Queue and recovery** 11. Please **re-queue** invoices ADMC/C/44447 to ADMC/C/44458 (the test records). 12. Please tell us the **number of records waiting** for transaction dates 01-01-2026 to today (we deliberately will not make test calls, because every call consumes records). 13. If a response is lost on our side (for example a network failure after you sent it), what is the process and turnaround to have those records **re-queued**? Who is the contact? 14. Any guidance on call frequency and time of day? We plan one call per hour, batches of 50.

**Network** 15. Do you restrict access by **IP address**? Our platform runs on Vercel, whose outbound addresses are not fixed. If you allow-list, we will arrange fixed addresses first.

Thank you,
Saveez Irfan
Al Das Medical
