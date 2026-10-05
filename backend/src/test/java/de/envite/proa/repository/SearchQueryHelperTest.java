package de.envite.proa.repository;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SearchQueryHelperTest {

	private static final SearchQueryHelper POSTGRESQL_HELPER = new SearchQueryHelper("postgresql");
	private static final SearchQueryHelper H2_HELPER = new SearchQueryHelper("h2");

	@Test
	void testIsFuzzySearchSupported() {
		assertThat(POSTGRESQL_HELPER.isFuzzySearchSupported()).isTrue();
		assertThat(H2_HELPER.isFuzzySearchSupported()).isFalse();
	}

	@Test
	void testSearchLabelCondition_PostgreSql_FuzzyOrExactMatch() {
		assertThat(POSTGRESQL_HELPER.searchLabelCondition("e.searchLabel"))
				.isEqualTo("( e.searchLabel = :searchLabel " +
						"OR function('levenshtein', e.searchLabel, :searchLabel) <= 4 )");
	}

	@Test
	void testSearchLabelCondition_H2_ExactMatchOnly() {
		assertThat(H2_HELPER.searchLabelCondition("e.searchLabel"))
				.isEqualTo("e.searchLabel = :searchLabel");
	}

	@Test
	void testFuzzyOrExactCondition_PostgreSql_CombinesExactConditionWithLevenshtein() {
		assertThat(POSTGRESQL_HELPER.fuzzyOrExactCondition("p.name = :name", "p.searchLabel"))
				.isEqualTo("( p.name = :name " +
						"OR function('levenshtein', p.searchLabel, :searchLabel) <= 4 )");
	}

	@Test
	void testFuzzyOrExactCondition_H2_ReturnsExactConditionUnchanged() {
		assertThat(H2_HELPER.fuzzyOrExactCondition("p.name = :name", "p.searchLabel"))
				.isEqualTo("p.name = :name");
	}
}
