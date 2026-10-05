package de.envite.proa.repository.datastore;

import de.envite.proa.repository.SearchQueryHelper;
import de.envite.proa.repository.tables.DataStoreTable;
import de.envite.proa.repository.tables.ProjectVersionTable;
import de.envite.proa.util.SearchLabelBuilder;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.persistence.NoResultException;
import jakarta.transaction.Transactional;

import java.util.List;

@ApplicationScoped
public class DataStoreDao {

	private EntityManager em;
	private SearchQueryHelper searchQueryHelper;

	@Inject
	public DataStoreDao(EntityManager em, SearchQueryHelper searchQueryHelper) {
		this.em = em;
		this.searchQueryHelper = searchQueryHelper;
	}

	@Transactional
	public void persist(DataStoreTable dataStoreTable) {
		em.persist(dataStoreTable);
	}

	@Transactional
	public List<DataStoreTable> getDataStores(ProjectVersionTable projectVersionTable) {
		return em //
				.createQuery("SELECT d FROM DataStoreTable d WHERE d.project = :project", DataStoreTable.class)//
				.setParameter("project", projectVersionTable)//
				.getResultList();
	}

	/**
	 * Throws {@link NoResultException} if no data store matches. Callers catch this to create
	 * the data store on demand, so the exception must not mark an enclosing transaction
	 * rollback-only (hence {@code dontRollbackOn}).
	 */
	@Transactional(dontRollbackOn = NoResultException.class)
	public DataStoreTable getDataStoreForLabel(String label, ProjectVersionTable projectVersionTable) {

		String searchLabel = SearchLabelBuilder.buildSearchLabel(label);

		return em.createQuery(
						 "SELECT d FROM DataStoreTable d " +
							"WHERE d.project = :project " +
							"AND " + searchQueryHelper.searchLabelCondition("d.searchLabel"),
						DataStoreTable.class)
				.setParameter("searchLabel", searchLabel)//
				.setParameter("project", projectVersionTable)//
				.getSingleResult();
	}
}
