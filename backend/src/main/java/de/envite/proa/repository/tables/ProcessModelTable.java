package de.envite.proa.repository.tables;

import de.envite.proa.entities.process.ProcessType;
import de.envite.proa.util.SearchLabelBuilder;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@NamedEntityGraph(
		name = "ProcessModel.withChildren",
		attributeNodes = @NamedAttributeNode("children")
)

@NamedEntityGraph(
		name = "ProcessModel.withParents",
		attributeNodes = @NamedAttributeNode("parents")
)

@NamedEntityGraph(
		name = "ProcessModel.withChildrenAndParents",
		attributeNodes = {
				@NamedAttributeNode("children"),
				@NamedAttributeNode("parents"),
		}
)

@NamedEntityGraph(
		name = "ProcessModel.withEventsAndActivities",
		attributeNodes = {
				@NamedAttributeNode("events"),
				@NamedAttributeNode("callActivites"),
		}
)

@Entity
@Getter
@Setter
public class ProcessModelTable {

	public ProcessModelTable() {
	}

	public ProcessModelTable(Long id) {
		this.id = id;
	}

	@Id
	@GeneratedValue(strategy = GenerationType.AUTO)
	public Long id;

	private String name;

    private String searchLabel;

	private String bpmnProcessId;

	@Column(columnDefinition = "BYTEA")
	@Basic(fetch = FetchType.LAZY)
	private byte[] bpmnXml;

	@OneToMany(cascade = CascadeType.ALL, mappedBy = "processModel", fetch = FetchType.LAZY)
	private Set<ProcessEventTable> events = new HashSet<>();

	@OneToMany(cascade = CascadeType.ALL, mappedBy = "processModel", fetch = FetchType.LAZY)
	private Set<CallActivityTable> callActivites = new HashSet<>();

	@OneToMany(cascade = CascadeType.ALL, mappedBy = "processModel", fetch = FetchType.LAZY)
	private List<ProcessDataStoreTable> dataStores = new ArrayList<>();

	@Lob
	@Column
	private String description;

	@Column
	private LocalDateTime createdAt;

	@ManyToOne(fetch = FetchType.LAZY)
	private ProjectVersionTable project;

	@ManyToMany(fetch = FetchType.LAZY)
	@JoinTable( //
			name = "processmodelrelations", //
			joinColumns = @JoinColumn(name = "parent_id"), //
			inverseJoinColumns = @JoinColumn(name = "child_id") //
	)
	private Set<ProcessModelTable> children = new HashSet<>();

	@ManyToMany(mappedBy = "children", fetch = FetchType.LAZY)
	private Set<ProcessModelTable> parents = new HashSet<>();

	private ProcessType processType;

    @PrePersist
    @PreUpdate
    private void generateSearchLabel() {
        this.searchLabel = SearchLabelBuilder.buildSearchLabel(this.name);
    }

	/**
	 * Identifier-based equality: instances are stored in {@link java.util.HashSet}s (children
	 * and parents) so equals and hashCode must not depend on mutable state or trigger lazy
	 * loading of relations. Unsaved instances (id == null) are only equal to themselves.
	 */
	@Override
	public boolean equals(Object obj) {
		if (this == obj) {
			return true;
		}
		if (!(obj instanceof ProcessModelTable other)) {
			return false;
		}
		return id != null && id.equals(other.getId());
	}

	@Override
	public int hashCode() {
		// Constant hash so that the value stays stable when the id is assigned on persist
		// and so that Hibernate proxies hash the same as their underlying entities.
		return ProcessModelTable.class.hashCode();
	}
}