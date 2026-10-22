### TEST - Unite Finance API (DO NOT RUN - each call consumes the Unite sync queue) (id 6555877)
- [1] datastore:GetRecord: datastore=61544
- [2] http:MakeRequest: url=https://ucexternalapiprod.uniteuae.care/gateway/GetFinanceDetails; method=post
- [3] datastore:AddRecord: datastore=167670
