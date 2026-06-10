package de.envite.proa.repository;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.eclipse.microprofile.config.inject.ConfigProperty;

/**
 * Encapsulates the db-kind specific decision of how labels are matched in search queries:
 * PostgreSQL supports the levenshtein function and therefore allows fuzzy matching, while
 * H2 falls back to an exact match.
 */
@ApplicationScoped
public class SearchQueryHelper {

	static final int MAX_LEVENSHTEIN_DISTANCE = 4;

	private static final String POSTGRESQL = "postgresql";

	private final String dbKind;

	@Inject
	public SearchQueryHelper(@ConfigProperty(name = "quarkus.datasource.db-kind") String dbKind) {
		this.dbKind = dbKind;
	}

	public boolean isFuzzySearchSupported() {
		return POSTGRESQL.equals(dbKind);
	}

	/**
	 * Builds the JPQL condition matching the given search-label path against the
	 * {@code :searchLabel} parameter: exact match or levenshtein distance on PostgreSQL,
	 * exact match only on other databases.
	 */
	public String searchLabelCondition(String searchLabelPath) {
		return fuzzyOrExactCondition(searchLabelPath + " = :searchLabel", searchLabelPath);
	}

	/**
	 * Combines the given exact-match condition with a levenshtein comparison of the given
	 * search-label path against the {@code :searchLabel} parameter on PostgreSQL. On other
	 * databases the exact-match condition is returned unchanged and {@code :searchLabel}
	 * is not referenced.
	 */
	public String fuzzyOrExactCondition(String exactMatchCondition, String searchLabelPath) {
		if (isFuzzySearchSupported()) {
			return "( " + exactMatchCondition + " OR function('levenshtein', " + searchLabelPath
					+ ", :searchLabel) <= " + MAX_LEVENSHTEIN_DISTANCE + " )";
		}
		return exactMatchCondition;
	}
}
