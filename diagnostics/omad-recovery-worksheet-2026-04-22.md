# Omad Recovery Worksheet

Snapshot date: 2026-04-22
Backup source: `diagnostics/omad-get_omad-backup-2026-04-22.json`

## Snapshot Summary

- Transactions in backup: 118
- Master tenant records in backup: 2
- Distinct tenant or ledger labels in transactions: 15
- Rate entries in backup: 1

## Master Tenants Returned By Live Data

- Tehnopark | rent=0 | currency=USD
- Bunyodbek | rent=0 | currency=USD

## Transaction Labels Missing From Master Tenants

- Apteka
- Bek Beka
- Dilyoraka
- Jahongiraka (Gaz Voda)
- Jahongiraka (Okarachka)
- Lochinaka
- Mirzohidaka
- O'quv Markaz
- Oziq Ovqat (Texnopark)
- Podval
- Qahramontog'a
- Umumiy Naqd Puldan
- Xurshidaka

## Months Seen In Transactions But Missing From Rates

- Aprel
- Mart

## Reconstruction Table

| Label | In master | Master rent | Master currency | Months seen | Income USD | Income UZS | Expense USD | Expense UZS | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Apteka | False |  |  | Aprel, Fevral, Mart | 800 | 4904000 | 0 | 884000 | Referenced by transactions but missing from master tenants list. |
| Bek Beka | False |  |  | Aprel, Fevral, Mart | 1400 | 3050000 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Bunyodbek | True | 0 | USD | Aprel, Fevral, Mart | 600 | 17482000 | 0 | 800000 | Master record exists but rent is currently 0; needs manual confirmation. |
| Dilyoraka | False |  |  | Aprel, Fevral, Mart | 700 | 3500000 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Jahongiraka (Gaz Voda) | False |  |  | Aprel, Fevral, Mart | 0 | 7677000 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Jahongiraka (Okarachka) | False |  |  | Aprel, Fevral, Mart | 400 | 20640000 | 0 | 7600000 | Referenced by transactions but missing from master tenants list. |
| Lochinaka | False |  |  | Aprel, Fevral, Mart | 300 | 0 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Mirzohidaka | False |  |  | Aprel, Fevral, Mart | 0 | 4031800 | 0 | 2777000 | Referenced by transactions but missing from master tenants list. |
| O'quv Markaz | False |  |  | Aprel, Fevral, Mart | 4200 | 600000 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Oziq Ovqat (Texnopark) | False |  |  | Aprel, Fevral, Mart | 850 | 2445000 | 0 | 1300000 | Referenced by transactions but missing from master tenants list. |
| Podval | False |  |  | Aprel, Fevral, Mart | 100 | 15300000 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Qahramontog'a | False |  |  | Aprel, Fevral, Mart | 150 | 12124000 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
| Tehnopark | True | 0 | USD | Aprel, Fevral, Mart | 1400 | 8500000 | 0 | 0 | Master record exists but rent is currently 0; needs manual confirmation. |
| Umumiy Naqd Puldan | False |  |  | Aprel, Fevral, Mart | 0 | 0 | 1400 | 147881900 | Ledger or expense source label; do not auto-recreate as a tenant. |
| Xurshidaka | False |  |  | Aprel, Fevral, Mart | 2100 | 0 | 0 | 0 | Referenced by transactions but missing from master tenants list. |
