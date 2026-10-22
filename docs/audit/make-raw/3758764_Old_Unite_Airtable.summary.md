### Old-Unite > Airtable (id 3758764)
- [1] datastore:GetRecord: datastore=61544
- [2] http:ActionSendData «Get Appointments»: url=https://ucexternalapiprod.uniteuae.care/gateway/GetMedicalRecordsDetails; method=post
- [5] builtin:BasicFeeder
- [6] builtin:BasicFeeder
- [7] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [200] airtable:ActionSearchRecords «Find existing MRD»: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
- [8] builtin:BasicRouter
  ↳ route
    - [9] airtable:ActionCreateRecord (filter: New patient, no MRD yet): base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
    - [132] airtable:ActionCreateRecord «Log Post-Visit Follow-Up»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
  ↳ route
    - [10] airtable:ActionUpdateRecords (filter: Existing patient, no MRD yet): base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
    - [202] builtin:BasicRouter
      ↳ route
        - [27] airtable:ActionCreateRecord (filter: MRD does not exist): base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
        - [224] util:SetVariable2
        - [225] util:GetVariables (filter: Skip - MRD already exists)
        - [212] util:SetVariable2 «Capture MRD id»
        - [220] airtable:ActionSearchRecords «Find existing PVFU»: base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
        - [222] builtin:BasicRouter
          ↳ route
            - [131] airtable:ActionCreateRecord «Log Post-Visit Follow-Up» (filter: PVFU does not exist): base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
          ↳ route
            - [221] airtable:ActionUpdateRecords «Update existing PVFU» (filter: PVFU exists): base=appZbwlQvkuaUsF2l; table=tblFQn2YMbmoqa6HF
          ↳ route
            - [36] builtin:BasicRouter
              ↳ route
                - [29] builtin:BasicFeeder
                - [32] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblZqf4Zcw5Kweadh
                - [41] builtin:BasicRouter
                  ↳ route
                    - [49] util:SetVariable2
                    - [45] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblZqf4Zcw5Kweadh/{{32.id}}; method=PATCH
                  ↳ route
                    - [53] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblZqf4Zcw5Kweadh/{{32.id}}; method=PATCH
              ↳ route
                - [30] builtin:BasicFeeder
                - [77] builtin:BasicRouter
                  ↳ route
                    - [33] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblLM2BXjA680GQws
                    - [54] builtin:BasicRouter
                      ↳ route
                        - [55] util:SetVariable2
                        - [56] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblLM2BXjA680GQws/{{33.id}}; method=PATCH
                      ↳ route
                        - [57] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblLM2BXjA680GQws/{{33.id}}; method=PATCH
                  ↳ route
                    - [79] util:TextAggregator
                    - [80] airtable:upsertRecord: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
                  ↳ route
                    - [81] util:TextAggregator
                    - [82] airtable:upsertRecord: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
              ↳ route
                - [28] builtin:BasicFeeder
                - [64] builtin:BasicRouter
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
                  ↳ route
                    - [101] builtin:BasicFeeder
                    - [102] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
                    - [103] builtin:BasicRouter
                      ↳ route
                        - [104] util:SetVariable2
                        - [105] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{102.id}}; method=PATCH
                      ↳ route
                        - [106] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{102.id}}; method=PATCH
                  ↳ route
                    - [107] builtin:BasicFeeder
                    - [108] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
                    - [109] builtin:BasicRouter
                      ↳ route
                        - [110] util:SetVariable2
                        - [111] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{108.id}}; method=PATCH
                      ↳ route
                        - [112] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{108.id}}; method=PATCH
                  ↳ route
                    - [113] builtin:BasicFeeder
                    - [114] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
                    - [115] builtin:BasicRouter
                      ↳ route
                        - [116] util:SetVariable2
                        - [117] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{114.id}}; method=PATCH
                      ↳ route
                        - [118] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{114.id}}; method=PATCH
                  ↳ route
                    - [119] builtin:BasicFeeder
                    - [120] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
                    - [121] builtin:BasicRouter
                      ↳ route
                        - [122] util:SetVariable2
                        - [123] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{120.id}}; method=PATCH
                      ↳ route
                        - [124] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{120.id}}; method=PATCH
                  ↳ route
                    - [125] builtin:BasicFeeder
                    - [126] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblTJtk6aIMbwpoA2
                    - [127] builtin:BasicRouter
                      ↳ route
                        - [128] util:SetVariable2
                        - [129] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{126.id}}; method=PATCH
                      ↳ route
                        - [130] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tblTJtk6aIMbwpoA2/{{126.id}}; method=PATCH
