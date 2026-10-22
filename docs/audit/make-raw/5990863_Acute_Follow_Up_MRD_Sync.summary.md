### Acute Follow-Up — MRD Sync (id 5990863)
- [1] airtable:ActionSearchRecords «Find unsynced recent visits»: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
- [2] airtable:ActionGetRecord «Get patient (DOB, department)» (filter: Patient link must exist): base=app7QJ2pvhADHQeBP; table=tbl9856qJP9S7OEqB
- [3] airtable:ActionCreateRecord «Create Visit in Acute base»: base=appH2jHpsNR1nqEQ2; table=tblyOweSP3FfeY9q0
- [4] airtable:ActionUpdateRecords «Mark visit synced»: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU
- [5] builtin:BasicFeeder «Iterate drug positions (1..n)»
- [6] airtable:ActionGetRecord «Get drug record (classification)»: base=app7QJ2pvhADHQeBP; table=tblLM2BXjA680GQws
- [7] airtable:ActionCreateRecord «Create Prescription»: base=appH2jHpsNR1nqEQ2; table=tblQra08AflxuXxQq
