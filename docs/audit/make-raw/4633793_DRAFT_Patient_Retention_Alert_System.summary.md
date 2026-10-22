### DRAFT - Patient Retention Alert System (id 4633793)
- [1] gateway:CustomWebHook
- [2] airtable:ActionCreateRecord (filter: Retention keyword matched): base=appZbwlQvkuaUsF2l; table=tblTBD_RetentionAlerts
- [3] http:ActionSendData: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-text; method=post
- [4] http:ActionSendData: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
