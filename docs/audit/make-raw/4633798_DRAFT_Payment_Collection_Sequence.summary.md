### DRAFT - Payment Collection Sequence (id 4633798)
- [1] airtable:ActionSearchRecords: base=appZbwlQvkuaUsF2l; table=tbl9856qJP9S7OEqB
- [2] builtin:BasicFeeder
- [3] builtin:BasicRouter
  ↳ route
    - [4] http:ActionSendData (filter: Day 3 (gentle)): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [5] http:ActionSendData (filter: Day 7 (gentle 2nd)): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [6] http:ActionSendData (filter: Day 14 (final)): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [7] http:ActionSendData (filter: Day 21 (billing mgr alert)): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-text; method=post
