### Lab Result Ready (id 4090446)
- [1] gateway:CustomWebHook
- [2] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl6LX9OJu8lBwSgf
- [3] builtin:BasicRouter
  ↳ route
    - [4] builtin:BasicFeeder
    - [9] builtin:BasicRouter
      ↳ route
        - [5] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tblopYbHPAbTi4QeX
        - [6] builtin:BasicRouter
          ↳ route
            - [7] util:SetVariable2 (filter: true)
          ↳ route
            - [8] util:SetVariable2 (filter: not true)
      ↳ route
        - [10] util:SetVariable2
  ↳ route
    - [11] util:GetVariable2
    - [12] builtin:BasicFeeder
    - [13] airtable:ActionGetRecord: base=appZbwlQvkuaUsF2l; table=tbl9856qJP9S7OEqB
    - [14] http:MakeRequest «Send Message»: url=https://developers.sanoflow.io/api/v1/messages/whatsapp/send-template; method=post
    - [15] airtable:ActionCreateRecord: base=appZbwlQvkuaUsF2l; table=tbl5wvAX6GidMm7n3
