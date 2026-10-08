### Chronic Recall - 90 Day (id 5882746)
- [1] airtable:ActionSearchRecords «Find Patients Due for Chronic Recall»: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB; view=viwXMAipcLg0wpcVt
- [2] http:ActionSendData «Send Template» (filter: Destination phone must not be empty): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
- [3] airtable:ActionCreateRecord «Log Send»: base=appkOnjPr1SMD83CP; table=tbldCbNEKeF5NrTCs
- [4] airtable:ActionUpdateRecords «Mark Recall Sent (Live only)»: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [23] builtin:BasicRouter
  ↳ route
    - [13] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
    - [14] builtin:BasicFeeder
    - [15] builtin:BasicFeeder
    - [16] util:TextAggregator
    - [17] builtin:BasicRouter
      ↳ route
        - [18] util:SetVariable2
        - [19] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
      ↳ route
        - [21] http:ActionSendData «Update Tag»: url=https://developers.sanoflow.io/api/v1.1/contacts/edit; method=post
