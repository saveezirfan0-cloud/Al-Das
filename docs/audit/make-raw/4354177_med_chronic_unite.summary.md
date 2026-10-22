### med-chronic-unite (id 4354177)
- [1] airtable:ActionSearchRecords: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
- [7] builtin:BasicRouter
  ↳ route
    - [2] util:SetVariable2
    - [4] builtin:BasicFeeder
    - [14] util:SetVariable2
    - [10] builtin:BasicAggregator
    - [5] util:SetVariable2
  ↳ route
    - [8] util:GetVariable2
    - [12] builtin:BasicFeeder
    - [3] builtin:BasicFeeder
    - [9] airtable:ActionGetRecord: base=app7QJ2pvhADHQeBP; table=tblLM2BXjA680GQws
    - [23] builtin:BasicRouter
      ↳ route
        - [19] util:TextAggregator
        - [18] util:SetVariable2
      ↳ route
        - [24] util:TextAggregator
        - [25] util:SetVariable2
  ↳ route
    - [26] util:GetVariables
    - [21] builtin:BasicFeeder
    - [30] airtable:makeApiCall: url=v0/app7QJ2pvhADHQeBP/tbl9856qJP9S7OEqB/{{21.value}}; method=PATCH
