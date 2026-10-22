### medical records sync (id 6251023)
- [138] datastore:GetRecord: datastore=61544
- [139] util:SetVariable2
- [3] http:ActionSendData «Get Appointments»: url=https://ucexternalapiprod.uniteuae.care/gateway/GetMedicalRecordsDetails; method=post
- [4] builtin:BasicFeeder
- [5] builtin:BasicFeeder
- [6] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [123] builtin:BasicIfElse
- [129] builtin:BasicMerge
- [134] util:GetVariables
- [11] airtable:ActionUpdateRecords (filter: Existing patient, no MRD yet): base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [13] airtable:ActionCreateRecord (filter: MRD does not exist): base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
- [16] util:SetVariable2 «Capture MRD id»
- [21] builtin:BasicRouter
  ↳ route
    - [22] builtin:BasicFeeder
    - [136] builtin:BasicRouter
      ↳ route
        - [23] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblZqf4Zcw5Kweadh
        - [24] builtin:BasicRouter
          ↳ route
            - [25] util:SetVariable2
            - [26] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblZqf4Zcw5Kweadh/{{23.id}}; method=PATCH
          ↳ route
            - [27] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblZqf4Zcw5Kweadh/{{23.id}}; method=PATCH
      ↳ route
        - [137] airtable:ActionUpdateRecords: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
  ↳ route
    - [28] builtin:BasicFeeder
    - [29] builtin:BasicRouter
      ↳ route
        - [30] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblLM2BXjA680GQws
        - [31] builtin:BasicRouter
          ↳ route
            - [32] util:SetVariable2
            - [33] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblLM2BXjA680GQws/{{30.id}}; method=PATCH
          ↳ route
            - [34] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblLM2BXjA680GQws/{{30.id}}; method=PATCH
      ↳ route
        - [35] util:TextAggregator
        - [36] airtable:upsertRecord: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
      ↳ route
        - [37] util:TextAggregator
        - [38] airtable:upsertRecord: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
  ↳ route
    - [39] builtin:BasicFeeder
    - [40] builtin:BasicRouter
      ↳ route
        - [41] builtin:BasicFeeder
        - [42] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [43] builtin:BasicRouter
          ↳ route
            - [44] util:SetVariable2
            - [45] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{42.id}}; method=PATCH
          ↳ route
            - [46] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{42.id}}; method=PATCH
      ↳ route
        - [47] builtin:BasicFeeder
        - [48] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [49] builtin:BasicRouter
          ↳ route
            - [50] util:SetVariable2
            - [51] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{48.id}}; method=PATCH
          ↳ route
            - [52] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{48.id}}; method=PATCH
      ↳ route
        - [53] builtin:BasicFeeder
        - [54] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [55] builtin:BasicRouter
          ↳ route
            - [56] util:SetVariable2
            - [57] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{54.id}}; method=PATCH
          ↳ route
            - [58] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{54.id}}; method=PATCH
      ↳ route
        - [59] builtin:BasicFeeder
        - [60] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [61] builtin:BasicRouter
          ↳ route
            - [62] util:SetVariable2
            - [63] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{60.id}}; method=PATCH
          ↳ route
            - [64] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{60.id}}; method=PATCH
      ↳ route
        - [65] builtin:BasicFeeder
        - [66] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [67] builtin:BasicRouter
          ↳ route
            - [68] util:SetVariable2
            - [69] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{66.id}}; method=PATCH
          ↳ route
            - [70] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{66.id}}; method=PATCH
      ↳ route
        - [71] builtin:BasicFeeder
        - [72] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [73] builtin:BasicRouter
          ↳ route
            - [74] util:SetVariable2
            - [75] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{72.id}}; method=PATCH
          ↳ route
            - [76] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{72.id}}; method=PATCH
      ↳ route
        - [77] builtin:BasicFeeder
        - [78] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [79] builtin:BasicRouter
          ↳ route
            - [80] util:SetVariable2
            - [81] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{78.id}}; method=PATCH
          ↳ route
            - [82] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{78.id}}; method=PATCH
      ↳ route
        - [83] builtin:BasicFeeder
        - [84] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [85] builtin:BasicRouter
          ↳ route
            - [86] util:SetVariable2
            - [87] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{84.id}}; method=PATCH
          ↳ route
            - [88] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{84.id}}; method=PATCH
      ↳ route
        - [89] builtin:BasicFeeder
        - [90] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [91] builtin:BasicRouter
          ↳ route
            - [92] util:SetVariable2
            - [93] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{90.id}}; method=PATCH
          ↳ route
            - [94] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{90.id}}; method=PATCH
      ↳ route
        - [95] builtin:BasicFeeder
        - [96] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
        - [97] builtin:BasicRouter
          ↳ route
            - [98] util:SetVariable2
            - [99] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{96.id}}; method=PATCH
          ↳ route
            - [100] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{96.id}}; method=PATCH
