package de.envite.proa.util;

import java.util.Locale;

/**
 * Normalizes e-mail addresses (trim + lower-case) so that token claims, invitation rows and
 * lookups compare equal regardless of capitalization or surrounding whitespace.
 */
public final class EmailNormalizer {

	private EmailNormalizer() {
	}

	/** Returns the trimmed, lower-cased e-mail, or {@code null} for null/blank input. */
	public static String normalize(String email) {
		if (email == null) {
			return null;
		}
		String normalized = email.trim().toLowerCase(Locale.ROOT);
		return normalized.isEmpty() ? null : normalized;
	}
}
