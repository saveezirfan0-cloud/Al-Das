### DRAFT - Insurance Verification Express (id 4633795)
- [1] gateway:CustomWebHook
- [2] airtable:ActionCreateRecord (filter: Insurance keyword matched): base=appZbwlQvkuaUsF2l; table=tblTBD_InsuranceVerification
- [3] http:ActionSendData: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
- [4] util:FunctionSleep
- [5] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tblTBD_InsuranceVerification
- [6] http:ActionSendData (filter: Still Pending (SLA breached)): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-text; method=post
