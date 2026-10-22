### Birthday Follow Ups (id 3613621)
- [1] airtable:ActionSearchRecords: base=appAkJDh7zJRMpoHL; table=tblCY6GHb35Rl1kxY
- [13] builtin:BasicRouter
  ↳ route
    - [3] http:ActionSendData «Get Patient»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
    - [5] builtin:BasicFeeder
    - [7] builtin:BasicFeeder
    - [8] builtin:BasicFeeder
    - [9] util:TextAggregator
    - [11] builtin:BasicRouter
      ↳ route
        - [10] airtable:ActionUpdateRecords: base=appAkJDh7zJRMpoHL; table=tblCY6GHb35Rl1kxY
        - [6] http:ActionSendData «Send Template Message»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template-alt; method=get
      ↳ route
        - [12] airtable:ActionUpdateRecords: base=appAkJDh7zJRMpoHL; table=tblCY6GHb35Rl1kxY
  ↳ route
    - [14] http:ActionSendData «Get Patient»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
    - [15] builtin:BasicFeeder
    - [16] builtin:BasicFeeder
    - [17] builtin:BasicFeeder
    - [18] util:TextAggregator
    - [19] builtin:BasicRouter
      ↳ route
        - [20] airtable:ActionUpdateRecords: base=appAkJDh7zJRMpoHL; table=tblCY6GHb35Rl1kxY
        - [21] http:ActionSendData «Send Template Message»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template-alt; method=get
