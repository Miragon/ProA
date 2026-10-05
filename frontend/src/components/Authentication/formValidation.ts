import i18n from "@/i18n";

const t = i18n.global.t;

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
