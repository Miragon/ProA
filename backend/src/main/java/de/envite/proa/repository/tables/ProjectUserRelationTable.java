package de.envite.proa.repository.tables;

import de.envite.proa.entities.project.ProjectRole;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.Getter;
import lombok.Setter;

// Unique (user, project): a user is a member of a project at most once. This is
// also the backstop that keeps parallel invitation redemptions (two concurrent
// first requests) and concurrent addContributor calls from creating duplicate
// memberships.
@Getter
@Setter
@Entity
@Table(uniqueConstraints = @UniqueConstraint(columnNames = { "user_id", "project_id" }))
public class ProjectUserRelationTable {

	@Id
	@GeneratedValue(strategy = GenerationType.AUTO)
	private Long id;
	
	@ManyToOne(fetch = FetchType.EAGER)
	private UserTable user;
	
	@ManyToOne(fetch = FetchType.LAZY)
	private ProjectTable project;
	
	@Enumerated(EnumType.STRING)
	private ProjectRole role;
}
