### DRAFT - Post-Visit Follow-Up Automation (id 4838337)
- [1] airtable:ActionSearchRecords «Find records ready to send»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
- [4] builtin:BasicRouter
  ↳ route
    - [5] http:ActionSendData «Send Day 0» (filter: Day 0 ready): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [6] airtable:ActionUpdateRecords «Mark Day 0 Sent + Queue Day 1»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
  ↳ route
    - [7] http:ActionSendData «Send Day 1» (filter: Day 1 ready): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [8] airtable:ActionUpdateRecords «Mark Day 1 Sent + Queue Day 3»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
  ↳ route
    - [9] http:ActionSendData «Send Day 3» (filter: Day 3 ready): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [10] airtable:ActionUpdateRecords «Mark Day 3 Sent + Queue Day 7»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
  ↳ route
    - [11] http:ActionSendData «Send Day 7» (filter: Day 7 ready): url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [12] airtable:ActionUpdateRecords «Mark Day 7 Sent + Complete»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
