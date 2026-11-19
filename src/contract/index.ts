// The field-sync v1 contract as the app sees it (tag field-sync-v1.3.0, copy in
// contracts/field-sync). The types are generated (scripts/contract-types.mjs);
// this file only gives them the names the app uses.
import { domains } from "./generated/domains";
import type { Item } from "./generated/uploadRequest";
import type { ChangeItem, Household } from "./generated/changes";
import type { ReferenceResponse } from "./generated/reference";

export { domains };

export type { SessionResponse } from "./generated/session";

export type {
  UploadRequest, Location, Address, NewPatient, RegistrationNewPatient, Participant, VisitReason, VisitMeasurements,
  HomeVisitBody as HomeVisitItemBody,
  HomeVisitWithdrawalBody as HomeVisitWithdrawalItemBody,
  CollectiveActivityBody as CollectiveActivityItemBody,
  PatientBody as PatientItemBody,
  HouseholdBody as HouseholdItemBody,
  FamilyBody as FamilyItemBody,
  IndividualRegistrationBody as RegistrationItemBody,
  VectorInspection as VectorInspectionBody,
  VectorDeposit, VectorMeasure, VectorSample, DepositGroup, OvitrapNumber,
  OvitrapInstallationBody as OvitrapInstallationItemBody,
  OvitrapCollectionBody as OvitrapCollectionItemBody,
} from "./generated/uploadRequest";
export type UploadItem = Item;
export type ItemType = Item["type"];

export type { UploadResponse, Result as UploadResult, Candidate } from "./generated/uploadResponse";

// The download shapes of GET /field/v1/changes: <household>, <registration>, <micro_area>
// and, from v1.3.0 (35a), <city_block>, <ovitrap>, <liraa_item> and <transmission_block>.
export type {
  ChangesResponse, ChangeItem, Removal, WhoToVisit, WhoItem, WhoReason,
  Household as HouseholdBody,
  Family as FamilyBody,
  Registration as RegistrationBody,
  MicroArea as MicroAreaBody,
  CityBlock as CityBlockBody,
  Ovitrap as OvitrapBody,
  LiraaItem as LiraaItemBody,
  TransmissionBlock as TransmissionBlockBody,
} from "./generated/changes";
export type ChangeType = ChangeItem["type"];
// <household>.vector: absent = gate off in the city, null = no profile (Q6).
export type HouseholdVector = Household["vector"];

export type { ReferenceResponse } from "./generated/reference";
// The reference's vector_control_domains block as the contract gives it (absent = no boletim).
export type VectorControlDomainsRaw = NonNullable<ReferenceResponse["vector_control_domains"]>;

// Every code here has a phrase in src/features/messages/errorPhrases.ts.
export const KNOWN_HTTP_ERRORS: readonly string[] = domains.errors.http;
export const KNOWN_ITEM_ERRORS: readonly string[] = domains.errors.item;
