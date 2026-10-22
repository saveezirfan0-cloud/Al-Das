### DRAFT - Antibiotic Follow-Up Conditional (id 4633800)
- [1] airtable:ActionSearchRecords: base=appZbwlQvkuaUsF2l; table=tblRNJcasTIz0vLhR
- [2] builtin:BasicFeeder
- [3] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl9856qJP9S7OEqB
- [4] http:ActionSendData: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
- [5] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
- [6] airtable:ActionUpdateRecords: base=appZbwlQvkuaUsF2l; table=tblRNJcasTIz0vLhR
