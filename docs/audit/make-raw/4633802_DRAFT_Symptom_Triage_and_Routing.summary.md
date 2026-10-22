### DRAFT - Symptom Triage and Routing (id 4633802)
- [1] gateway:CustomWebHook
- [2] builtin:BasicRouter
  ↳ route
    - [3] http:ActionSendData (filter: P1 Emergency): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [5] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tblTBD_SymptomTriageLog
  ↳ route
    - [6] http:ActionSendData (filter: P2 Urgent): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [8] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tblTBD_SymptomTriageLog
  ↳ route
    - [9] http:ActionSendData (filter: P3 Routine): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [10] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tblTBD_SymptomTriageLog
