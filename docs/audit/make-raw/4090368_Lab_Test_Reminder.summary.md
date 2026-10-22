### Lab Test Reminder (id 4090368)
- [1] airtable:ActionSearchRecords: base=appZbwlQvkuaUsF2l; table=tbl6LX9OJu8lBwSgf
- [6] builtin:BasicRouter
  ↳ route
    - [7] builtin:BasicFeeder
    - [13] builtin:BasicRouter
      ↳ route
        - [8] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl5wvAX6GidMm7n3
        - [9] util:TextAggregator
        - [11] builtin:BasicRouter
          ↳ route
            - [10] util:SetVariable2
          ↳ route
            - [12] util:SetVariable2
      ↳ route
        - [14] util:SetVariable2
  ↳ route
    - [15] util:GetVariable2
    - [2] builtin:BasicFeeder
    - [4] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl9856qJP9S7OEqB
    - [3] http:MakeRequest «Send Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
    - [5] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tbl5wvAX6GidMm7n3
