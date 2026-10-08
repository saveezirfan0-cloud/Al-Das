### Appointment Reminders (id 3613818)
- [1] datastore:GetRecord: datastore=61544
- [3] util:SetVariable2
- [4] builtin:BasicRouter
  ↳ route
    - [6] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Golden Mile): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments?clinic_id=DHA-F-6456618&from_date={{3.Date}}&to_date=; method=get
    - [15] builtin:BasicFeeder
    - [14] http:ActionSendData «Send Template: appointment_reminder_48h»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [30] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
  ↳ route
    - [7] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Meadows): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments?clinic_id=DHA-F-2116734&from_date={{3.Date}}&to_date=; method=get
    - [17] builtin:BasicFeeder
    - [18] http:ActionSendData «Send Template: appointment_reminder_48h»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [31] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
  ↳ route
    - [5] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Palm Jumeirah): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments?clinic_id=DHA-F-0000419&from_date={{3.Date}}&to_date=; method=get
    - [13] builtin:BasicFeeder
    - [16] http:ActionSendData «Send Template: appointment_reminder_48h»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
    - [29] airtable:ActionCreateRecord: base=appkOnjPr1SMD83CP; table=tblhoSfiSjO4zh9cf
