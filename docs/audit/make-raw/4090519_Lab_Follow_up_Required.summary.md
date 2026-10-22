### Lab Follow-up Required (id 4090519)
- [1] gateway:CustomWebHook
- [2] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl6LX9OJu8lBwSgf
- [3] builtin:BasicRouter
  ↳ route
    - [12] builtin:BasicFeeder
    - [13] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl9856qJP9S7OEqB
    - [14] http:MakeRequest «Send Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
    - [15] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tbl5wvAX6GidMm7n3
