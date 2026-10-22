### Birthday_Campaign (id 3600529)
- [1] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [29] util:FunctionSleep
- [30] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
- [4] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [21] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
- [22] builtin:BasicFeeder
- [23] builtin:BasicFeeder
- [24] util:TextAggregator
- [25] builtin:BasicRouter
  ↳ route
    - [26] util:SetVariable2
    - [27] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
    - [32] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
  ↳ route
    - [28] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
    - [33] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
