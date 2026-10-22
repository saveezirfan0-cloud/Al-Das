### Clinics & Appts (id 3576553)
- [1] datastore:GetRecord: datastore=61544
- [2] http:ActionSendData «Get Clinics»: url=https://ucexternalapiprod.uniteuae.care/gateway/getclinics; method=get
- [4] builtin:BasicFeeder
- [3] http:ActionSendData «Get Appointments»: url=https://ucexternalapiprod.uniteuae.care/gateway/getallappointments; method=get
