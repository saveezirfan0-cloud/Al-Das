### Unite > Sano Appointment Sync (id 5480742)
- [2] datastore:GetRecord: datastore=61544
- [3] util:SetVariable2
- [4] builtin:BasicRouter
  ↳ route
    - [5] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Golden Mile): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [6] builtin:BasicFeeder
    - [12] util:SetVariable2
    - [13] google-sheets:filterRows
    - [30] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
    - [14] builtin:BasicRouter
      ↳ route
        - [11] http:MakeRequest: url=https://developers.sanoflow.io/api/v1.1/appointments/add; method=post
      ↳ route
        - [15] http:MakeRequest: url=https://developers.sanoflow.io/api/v1.1/appointments/add; method=post
  ↳ route
    - [16] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Meadows): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [17] builtin:BasicFeeder
    - [18] util:SetVariable2
    - [19] google-sheets:filterRows
    - [31] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
    - [20] builtin:BasicRouter
      ↳ route
        - [21] http:MakeRequest: url=https://developers.sanoflow.io/api/v1.1/appointments/add; method=post
      ↳ route
        - [22] http:MakeRequest: url=https://developers.sanoflow.io/api/v1.1/appointments/add; method=post
  ↳ route
    - [23] http:ActionSendData «Get Appointments» (filter: Al Das Medical Clinic - Palm Jumeirah): url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
    - [24] builtin:BasicFeeder
    - [25] util:SetVariable2
    - [26] google-sheets:filterRows
    - [32] http:ActionSendData «Get Contact»: url=https://developers.sanoflow.io/api/v1.1/contacts/list; method=get
    - [27] builtin:BasicRouter
      ↳ route
        - [28] http:MakeRequest: url=https://developers.sanoflow.io/api/v1.1/appointments/add; method=post
      ↳ route
        - [29] http:MakeRequest: url=https://developers.sanoflow.io/api/v1.1/appointments/add; method=post
