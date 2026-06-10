package de.envite.proa.repository.processmodel;

import de.envite.proa.entities.process.ProcessType;
import de.envite.proa.repository.SearchQueryHelper;
import de.envite.proa.repository.tables.ProcessModelTable;
import de.envite.proa.repository.tables.ProjectVersionTable;
import de.envite.proa.util.SearchLabelBuilder;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.persistence.EntityGraph;
import jakarta.persistence.EntityManager;
import jakarta.persistence.TypedQuery;
import jakarta.transaction.Transactional;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RequestScoped
public class ProcessModelDao {

	private EntityManager em;
	private SearchQueryHelper searchQueryHelper;

	@Inject
	public ProcessModelDao(EntityManager em, SearchQueryHelper searchQueryHelper) {
		this.em = em;
		this.searchQueryHelper = searchQueryHelper;
	}

	@Transactional
	public List<ProcessModelTable> getProcessModelsWithChildren(ProjectVersionTable projectVersionTable) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withChildren");
		String query = "SELECT p " +
				"FROM ProcessModelTable p " +
				"WHERE p.project = :project";
		return em.createQuery(query, ProcessModelTable.class)
				.setParameter("project", projectVersionTable)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getResultList();
	}

	@Transactional
	public List<ProcessModelTable> getProcessModelsWithoutCollaborationsAndWithEventsAndActivities(
			ProjectVersionTable projectVersionTable) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withEventsAndActivities");
		String query = "SELECT p " +
				"FROM ProcessModelTable p " +
				"WHERE p.project = :project " +
				"AND (p.processType != :collaboration OR p.processType IS NULL)";
		return em.createQuery(query, ProcessModelTable.class)
				.setParameter("collaboration", ProcessType.COLLABORATION)
				.setParameter("project", projectVersionTable)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getResultList();
	}

	@Transactional
	public List<ProcessModelTable> getProcessModelsForName(String name, ProjectVersionTable projectVersionTable) {

		TypedQuery<ProcessModelTable> query = em
				.createQuery(
						"SELECT p " +
								"FROM ProcessModelTable p " +
								"WHERE " + searchQueryHelper.fuzzyOrExactCondition("p.name = :name", "p.searchLabel") +
								" AND p.project = :project",
						ProcessModelTable.class)
				.setParameter("name", name)
				.setParameter("project", projectVersionTable);

		if (searchQueryHelper.isFuzzySearchSupported()) {
			query.setParameter("searchLabel", SearchLabelBuilder.buildSearchLabel(name));
		}

		return query.getResultList();
	}

	@Transactional
	public void persist(ProcessModelTable table) {
		em.persist(table);
	}

	@Transactional
	public void merge(ProcessModelTable table) {
		em.merge(table);
	}

	@Transactional
	public ProcessModelTable findWithParentsAndChildren(Long id) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withChildrenAndParents");
		String query = "SELECT p " +
				"FROM ProcessModelTable p " +
				"WHERE p.id = :id";
		return em.createQuery(query, ProcessModelTable.class)
				.setParameter("id", id)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getSingleResult();
	}

	@Transactional
	public ProcessModelTable findWithChildren(Long id) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withChildren");
		String query = "SELECT p " +
				"FROM ProcessModelTable p " +
				"WHERE p.id = :id";
		return em.createQuery(query, ProcessModelTable.class)
				.setParameter("id", id)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getSingleResult();
	}

	@Transactional
	public ProcessModelTable findWithParents(Long id) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withParents");
		String query = "SELECT p " +
				"FROM ProcessModelTable p " +
				"WHERE p.id = :id";
		return em.createQuery(query, ProcessModelTable.class)
				.setParameter("id", id)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getSingleResult();
	}

	@Transactional
	public ProcessModelTable find(Long id) {
		return em.find(ProcessModelTable.class, id);
	}

	@Transactional
	public ProcessModelTable findWithEventsAndActivities(Long id) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withEventsAndActivities");
		String query = "SELECT p " +
				"FROM ProcessModelTable p " +
				"WHERE p.id = :id";
		return em.createQuery(query, ProcessModelTable.class)
				.setParameter("id", id)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getSingleResult();
	}

	@Transactional
	public byte[] getBpmnXml(Long id) {
		EntityGraph<ProcessModelTable> graph = em.createEntityGraph(ProcessModelTable.class);

		Map<String, Object> hints = new HashMap<>();
		hints.put("jakarta.persistence.fetchgraph", graph);

		return em.find(ProcessModelTable.class, id, hints).getBpmnXml();
	}

	@Transactional
	public ProcessModelTable findByBpmnProcessIdWithChildren(String bpmnProcessId,
			ProjectVersionTable projectVersionTable) {
		EntityGraph<?> graph = em.getEntityGraph("ProcessModel.withChildren");
		List<ProcessModelTable> processModels = em
				.createQuery(
						"SELECT p " +
								"FROM ProcessModelTable p " +
								"WHERE p.bpmnProcessId = :bpmnProcessId " +
								"AND p.project = :project",
						ProcessModelTable.class
				)
				.setParameter("bpmnProcessId", bpmnProcessId)
				.setParameter("project", projectVersionTable)
				.setHint("jakarta.persistence.loadgraph", graph)
				.getResultList();

		return !processModels.isEmpty() ? processModels.getFirst() : null;
	}

	@Transactional
	public void delete(Long id) {
		ProcessModelTable table = em.find(ProcessModelTable.class, id);
		em.remove(table);
	}

	@Transactional
	public void delete(List<Long> processModelIds) {
		// Earlier steps of the surrounding transaction may have loaded connection entities
		// whose rows have since been bulk-deleted (e.g. in deleteForProcessModel). Flush and
		// clear the persistence context so those stale entities are not flush-checked against
		// the process models removed below.
		em.flush();
		em.clear();
		processModelIds.forEach(this::delete);
	}

	@Transactional
	public ProcessModelTable findByNameOrBpmnProcessIdWithoutCollaborations(String name, String bpmnProcessId,
			ProjectVersionTable projectVersionTable) {
		List<ProcessModelTable> processModels = em
				.createQuery(
						"SELECT p " +
								"FROM ProcessModelTable p " +
								"WHERE (p.name = :name OR p.bpmnProcessId = :bpmnProcessId) " +
								"AND (p.processType != :collaboration OR p.processType IS NULL) " +
								"AND p.project = :project",
						ProcessModelTable.class
				)
				.setParameter("name", name)
				.setParameter("bpmnProcessId", bpmnProcessId)
				.setParameter("collaboration", ProcessType.COLLABORATION)
				.setParameter("project", projectVersionTable)
				.getResultList();

		return processModels.isEmpty() ? null : processModels.getFirst();
	}

	@Transactional
	public void addChild(Long parentId, Long childId) {
		ProcessModelTable parent = em.find(ProcessModelTable.class, parentId);
		ProcessModelTable child = em.find(ProcessModelTable.class, childId);
		parent.getChildren().add(child);
		em.merge(parent);
	}

	@Transactional
	public void removeChild(Long parentId, Long childId) {
		ProcessModelTable parent = em.find(ProcessModelTable.class, parentId);
		ProcessModelTable child = em.find(ProcessModelTable.class, childId);
		parent.getChildren().remove(child);
		em.merge(parent);
	}
}
