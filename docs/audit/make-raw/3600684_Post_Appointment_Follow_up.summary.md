### Post-Appointment Follow-up (id 3600684)
- [1] datastore:GetRecord: datastore=61544
- [2] util:SetVariable2
- [3] builtin:BasicRouter
  ↳ route
    - [4] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Palm Jumeirah): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [5] builtin:BasicFeeder
    - [24] http:ActionSendData «Send Template: POST-APPOINTMENT FOLLOW-UP»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [6] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Golden Mile): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [7] builtin:BasicFeeder
    - [25] http:ActionSendData «Send Template: POST-APPOINTMENT FOLLOW-UP»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [8] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Meadows): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [9] builtin:BasicFeeder
    - [26] http:ActionSendData «Send Template: POST-APPOINTMENT FOLLOW-UP»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
