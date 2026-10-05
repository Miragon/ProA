package de.envite.proa.repository.processmodel;

import de.envite.proa.repository.SearchQueryHelper;
import de.envite.proa.repository.tables.CallActivityTable;
import de.envite.proa.repository.tables.ProcessModelTable;
import de.envite.proa.repository.tables.ProjectVersionTable;
import de.envite.proa.util.SearchLabelBuilder;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;

import java.util.List;

@RequestScoped
public class CallActivityDao {

	private final EntityManager em;
	private final SearchQueryHelper searchQueryHelper;

	@Inject
	public CallActivityDao(EntityManager em, SearchQueryHelper searchQueryHelper) {
		this.em = em;
		this.searchQueryHelper = searchQueryHelper;
	}

	@Transactional
	public void persist(CallActivityTable table) {
		em.persist(table);
	}

	@Transactional
	public List<CallActivityTable> getCallActivitiesForName(String label, ProjectVersionTable projectVersionTable) {

		String searchLabel = SearchLabelBuilder.buildSearchLabel(label);

		return em.createQuery(
						 "SELECT c FROM CallActivityTable c " +
							"WHERE c.project = :project " +
							"AND " + searchQueryHelper.searchLabelCondition("c.searchLabel"),
						CallActivityTable.class)
				.setParameter("searchLabel", searchLabel)//
				.setParameter("project", projectVersionTable)//
				.getResultList();
	}

	@Transactional
	public CallActivityTable findForProcessModel(ProcessModelTable processModel) {
		return em
				.createQuery("SELECT c FROM CallActivityTable c WHERE c.processModel = :processModel",
						CallActivityTable.class)
				.setParameter("processModel", processModel)//
				.getResultList() //
				.stream() //
				.findFirst() //
				.orElse(null);
	}
}