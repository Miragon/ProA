// bpmn-moddle instances with the engine-specific extension descriptors.
import { BpmnModdle } from 'bpmn-moddle';
import camunda from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };
import zeebe from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import modeler from 'modeler-moddle/resources/modeler.json' with { type: 'json' };

/** c7 -> bpmn + camunda + modeler; c8 -> bpmn + zeebe + modeler. */
export function createModdle(engine) {
  if (engine === 'c7') return new BpmnModdle({ camunda, modeler });
  if (engine === 'c8') return new BpmnModdle({ zeebe, modeler });
  throw new Error(`unknown engine ${engine}`);
}
