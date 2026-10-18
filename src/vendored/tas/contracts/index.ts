/**
 * lib/contracts/index.ts — re-export of the versioned API contracts.
 */
export {
  APPOINTMENT_CONTRACT_VERSION,
  AppointmentStatus,
  AppointmentContract,
  AppointmentCreateInput,
  BookingStatusTransition,
  STATUS_TRANSITIONS,
  UtcDatetime,
  ContainerNumber,
  parseAppointment,
  parseAppointmentCreateInput,
  validateAppointment,
  validateTransition,
  newAppointmentId,
} from "./appointment";
export type {
  ContractIssue,
  ParseResult,
  Appointment,
  AppointmentCreateInput as AppointmentCreateInputType,
  AppointmentStatus as AppointmentStatusType,
  BookingStatusTransition as BookingStatusTransitionType,
} from "./appointment";

export {
  RECOMMENDATION_CONTRACT_VERSION,
  RecommendationStatus,
  RecommendationContract,
  RecommendationCreateInput,
  RECOMMENDATION_TRANSITIONS,
  parseRecommendation,
  parseRecommendationCreateInput,
  validateRecommendationTransition,
  newRecommendationId,
} from "./recommendation";
export type {
  Recommendation,
  RecommendationCreateInput as RecommendationCreateInputType,
  RecommendationStatus as RecommendationStatusType,
  RecommendationPayload,
} from "./recommendation";
