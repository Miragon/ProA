package de.envite.proa.repository.tables;

import java.time.LocalDateTime;

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

/**
 * Pending project invitation (ADR-0003): an owner invited an e-mail address that has no local
 * user yet. Redeemed into a {@link ProjectUserRelationTable} membership (and deleted) on the
 * invitee's first login with a verified e-mail. The e-mail is stored normalized
 * (trimmed + lower-cased); unique per (e-mail, project) so re-inviting is idempotent.
 */
@Getter
@Setter
@Entity
@Table(uniqueConstraints = @UniqueConstraint(columnNames = { "email", "project_id" }))
public class ProjectInvitationTable {

	@Id
	@GeneratedValue(strategy = GenerationType.AUTO)
	private Long id;

	private String email;

	@ManyToOne(fetch = FetchType.LAZY)
	private ProjectTable project;

	@Enumerated(EnumType.STRING)
	private ProjectRole role = ProjectRole.COLLABORATEUR;

	private Long invitedBy;

	private LocalDateTime createdAt;
}
