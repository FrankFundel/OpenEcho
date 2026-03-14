class ClassifierService:
  def __init__(self):
    self._bacpipe_service = None

  def _get_bacpipe_service(self):
    if self._bacpipe_service is None:
      from backend.inference.bacpipe_provider import BacpipeClassifierService

      self._bacpipe_service = BacpipeClassifierService()

    return self._bacpipe_service

  def predict(self, classifier_config, recording_path, proclen=0):
    return self._get_bacpipe_service().predict(
      classifier_config,
      recording_path,
      proclen=proclen,
    )

  def validate(self, classifier_config):
    self._get_bacpipe_service().validate(classifier_config)
