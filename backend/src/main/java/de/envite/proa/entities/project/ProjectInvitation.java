package de.envite.proa.entities.project;

import java.time.LocalDateTime;

import lombok.Getter;
import lombok.Setter;

/**
 * A pending project invitation: an e-mail address invited by a project owner that has not been
 * redeemed into a membership yet (ADR-0003).
 */
@Getter
@Setter
public class ProjectInvitation {

	private Long id;
	private String email;
	private ProjectRole role;
	private Long invitedBy;
	private LocalDateTime createdAt;
}
