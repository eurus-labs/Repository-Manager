Messaging requirements (illustrative)
=====================================

REQ-012: Send messages with a visible delivery status
-----------------------------------------------------

Users can send a text message and see whether it was delivered, failed,
or is still pending.

- A failed message shows the failure reason.
- The sending status survives an app restart.

REQ-013: Manual retry
---------------------

Users can retry a message whose sending failed.

Requirements written as sphinx-needs directives are read too:

.. req:: Read receipts
   :id: REQ_020
   :status: open

   Users can see when the recipient has read a message.
