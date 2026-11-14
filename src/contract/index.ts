// The field-sync v1 contract as the app sees it (tag field-sync-v1.2.0, copy in
// contracts/field-sync). The types are generated (scripts/contract-types.mjs);
// this file only gives them the names the app uses.
import { domains } from "./generated/domains";
import type { Item } from "./generated/uploadRequest";

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
} from "./generated/uploadRequest";
export type UploadItem = Item;
export type ItemType = Item["type"];

export type { UploadResponse, Result as UploadResult, Candidate } from "./generated/uploadResponse";

// The download shapes: <household>, <registration> and <micro_area> of GET /field/v1/changes.
export type {
  ChangesResponse, ChangeItem, Removal, WhoToVisit, WhoItem, WhoReason,
  Household as HouseholdBody,
  Family as FamilyBody,
  Registration as RegistrationBody,
  MicroArea as MicroAreaBody,
} from "./generated/changes";

export type { ReferenceResponse } from "./generated/reference";

// Every code here has a phrase in src/features/messages/errorPhrases.ts.
export const KNOWN_HTTP_ERRORS: readonly string[] = domains.errors.http;
export const KNOWN_ITEM_ERRORS: readonly string[] = domains.errors.item;
