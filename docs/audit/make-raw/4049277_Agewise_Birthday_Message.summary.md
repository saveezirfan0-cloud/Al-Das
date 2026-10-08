### Agewise Birthday Message (id 4049277)
- [1] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [2] builtin:BasicRouter
  ↳ route
    - [3] builtin:BasicRouter (filter: Men)
      ↳ route
        - [5] util:FunctionSleep (filter: 20s)
        - [6] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
        - [7] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
        - [8] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
        - [9] builtin:BasicFeeder
        - [10] builtin:BasicFeeder
        - [11] util:TextAggregator
        - [12] builtin:BasicRouter
          ↳ route
            - [13] util:SetVariable2
            - [14] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [15] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
          ↳ route
            - [16] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [17] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
      ↳ route
        - [19] util:FunctionSleep (filter: 30s)
        - [20] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
        - [21] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
        - [22] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
        - [23] builtin:BasicFeeder
        - [24] builtin:BasicFeeder
        - [25] util:TextAggregator
        - [26] builtin:BasicRouter
          ↳ route
            - [27] util:SetVariable2
            - [28] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [29] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
          ↳ route
            - [30] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [31] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
      ↳ route
        - [45] util:FunctionSleep (filter: 50s)
        - [46] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
        - [47] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
        - [48] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
        - [49] builtin:BasicFeeder
        - [50] builtin:BasicFeeder
        - [51] util:TextAggregator
        - [52] builtin:BasicRouter
          ↳ route
            - [53] util:SetVariable2
            - [54] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [55] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
          ↳ route
            - [56] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [57] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
  ↳ route
    - [4] builtin:BasicRouter (filter: Women)
      ↳ route
        - [58] util:FunctionSleep (filter: 18-25)
        - [59] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
        - [60] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
        - [61] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
        - [62] builtin:BasicFeeder
        - [63] builtin:BasicFeeder
        - [64] util:TextAggregator
        - [65] builtin:BasicRouter
          ↳ route
            - [66] util:SetVariable2
            - [67] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [68] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
          ↳ route
            - [69] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [70] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
      ↳ route
        - [71] util:FunctionSleep (filter: 26-35)
        - [72] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
        - [73] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
        - [74] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
        - [75] builtin:BasicFeeder
        - [76] builtin:BasicFeeder
        - [77] util:TextAggregator
        - [78] builtin:BasicRouter
          ↳ route
            - [79] util:SetVariable2
            - [80] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [81] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
          ↳ route
            - [82] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [83] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
      ↳ route
        - [84] util:FunctionSleep (filter: 36-45)
        - [85] http:MakeRequest «Send Birthday Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
        - [86] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
        - [87] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
        - [88] builtin:BasicFeeder
        - [89] builtin:BasicFeeder
        - [90] util:TextAggregator
        - [91] builtin:BasicRouter
          ↳ route
            - [92] util:SetVariable2
            - [93] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [94] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
          ↳ route
            - [95] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
            - [96] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblHTlF6LXMK5p4mU
