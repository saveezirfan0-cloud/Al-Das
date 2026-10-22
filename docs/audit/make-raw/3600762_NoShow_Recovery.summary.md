### NoShow_Recovery (id 3600762)
- [1] datastore:GetRecord: datastore=61544
- [2] util:SetVariable2
- [3] builtin:BasicRouter
  ↳ route
    - [4] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Palm Jumeirah): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [5] builtin:BasicFeeder
    - [19] http:ActionSendData «Send Template: NO-SHOW RECOVERY»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [6] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Golden Mile): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [7] builtin:BasicFeeder
    - [20] http:ActionSendData «Send Template: NO-SHOW RECOVERY»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
  ↳ route
    - [8] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Meadows): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [9] builtin:BasicFeeder
    - [21] http:ActionSendData «Send Template: NO-SHOW RECOVERY»: url=https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template; method=post
