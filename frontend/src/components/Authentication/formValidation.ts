import i18n from "@/i18n";

const t = i18n.global.t;

export type ValidationRule = (value: string) => boolean | string;

/**
 * Runs a value through Vuetify-style validation rules and returns the first
 * error message, or an empty string when the value is valid.
 */
export function firstRuleError(value: string, rules: ValidationRule[]): string {
  for (const rule of rules) {
    const result = rule(value);
    if (typeof result === "string") {
      return result;
    }
  }
  return "";
}

export const baseEmailRules = [
  (email: string) =>
    !!email || `${t("authentication.email")} ${t("validation.isRequired")}`,
  (email: string) =>
    email.length <= 64 ||
    `${t("authentication.email")} ${t("validation.max64Characters")}`
];

export const emailRules = baseEmailRules.concat([
  (email: string) =>
    /.+@.+\..+/.test(email) ||
    `${t("authentication.email")} ${t("validation.mustBeValid")}`
]);

export const firstNameRules = [
  (firstName: string) =>
    !!firstName ||
    `${t("authentication.firstName")} ${t("validation.isRequired")}`,
  (firstName: string) =>
    firstName.length <= 64 ||
    `${t("authentication.firstName")} ${t("validation.max64Characters")}`
];

export const lastNameRules = [
  (lastName: string) =>
    !!lastName ||
    `${t("authentication.lastName")} ${t("validation.isRequired")}`,
  (lastName: string) =>
    lastName.length <= 64 ||
    `${t("authentication.lastName")} ${t("validation.max64Characters")}`
];
