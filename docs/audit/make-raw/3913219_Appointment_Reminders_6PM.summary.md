### Appointment Reminders - 6PM (id 3913219)
- [1] datastore:GetRecord: datastore=61544
- [2] util:SetVariable2
- [3] builtin:BasicRouter
  ↳ route
    - [4] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Golden Mile): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments?clinic_id=DHA-F-6456618&from_date={{2.Date}}&to_date=; method=get
    - [5] builtin:BasicFeeder
    - [37] airtable:ActionSearchRecords: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
    - [6] http:ActionSendData «Send Template: appointment_reminder_48h»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [14] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
  ↳ route
    - [15] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Meadows): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments?clinic_id=DHA-F-2116734&from_date={{2.Date}}&to_date=; method=get
    - [16] builtin:BasicFeeder
    - [38] airtable:ActionSearchRecords: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
    - [17] http:ActionSendData «Send Template: appointment_reminder_48h»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [25] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
  ↳ route
    - [26] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Palm Jumeirah): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments?clinic_id=DHA-F-0000419&from_date={{2.Date}}&to_date=; method=get
    - [27] builtin:BasicFeeder
    - [39] airtable:ActionSearchRecords: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
    - [28] http:ActionSendData «Send Template: appointment_reminder_48h»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [36] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
