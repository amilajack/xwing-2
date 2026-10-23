data "aws_caller_identity" "current" {}
data "aws_vpc" "default" {
  default = true
}
data "aws_subnet" "selected" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "availability-zone"
    values = [var.availability_zone]
  }
}
data "aws_ssm_parameter" "ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}
resource "aws_security_group" "game" {
  name_prefix = "xwing-coop-"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_eip" "game" {
  domain = "vpc"
  tags = {
    Name = "xwing-coop"
  }
}
resource "aws_route53_record" "game" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "A"
  ttl     = 60
  records = [aws_eip.game.public_ip]
}
resource "aws_iam_role" "instance" {
  name = "xwing-coop-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ec2.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "instance" {
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = ["arn:aws:s3:::${var.artifact_bucket}/releases/*", "arn:aws:s3:::${var.artifact_bucket}/certificates/*"]
      },
      {
        Effect = "Allow", Action = ["s3:PutObject"], Resource = "arn:aws:s3:::${var.artifact_bucket}/certificates/*"
      },
      {
        Effect = "Allow", Action = ["ssm:GetParameters"], Resource = "arn:aws:ssm:us-west-1:${data.aws_caller_identity.current.account_id}:parameter/xwing-coop/*"
      },
      {
        Effect = "Allow", Action = ["ec2:AssociateAddress"], Resource = [aws_eip.game.arn, "arn:aws:ec2:us-west-1:${data.aws_caller_identity.current.account_id}:instance/*"]
      },
      {
        Effect = "Allow", Action = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"], Resource = "arn:aws:route53:::hostedzone/${var.zone_id}"
      },
      {
        Effect = "Allow", Action = ["route53:GetChange"], Resource = "arn:aws:route53:::change/*"
      },
      {
        Effect = "Allow", Action = ["route53:ListHostedZonesByName"], Resource = "*"
      }
    ]
  })
}
resource "aws_iam_instance_profile" "game" {
  name = "xwing-coop"
  role = aws_iam_role.instance.name
}
resource "aws_launch_template" "game" {
  name_prefix   = "xwing-coop-"
  image_id      = data.aws_ssm_parameter.ami.value
  instance_type = var.instance_type
  iam_instance_profile {
    name = aws_iam_instance_profile.game.name
  }
  vpc_security_group_ids = [aws_security_group.game.id]
  credit_specification {
    cpu_credits = "standard"
  }
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  user_data = base64encode(templatefile("${path.module}/../../ops/bootstrap.sh.tftpl", {
    bucket = var.artifact_bucket, key = var.artifact_key, allocation = aws_eip.game.id, hostname = var.hostname, email = var.acme_email, origins = var.allowed_origins
  }))
  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "xwing-coop"
    }
  }
}
resource "aws_autoscaling_group" "game" {
  name                      = "xwing-coop"
  min_size                  = 0
  max_size                  = 1
  desired_capacity          = var.enable_capacity ? 1 : 0
  vpc_zone_identifier       = [data.aws_subnet.selected.id]
  wait_for_capacity_timeout = "0"
  health_check_grace_period = 300
  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "lowest-price"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.game.id
        version            = aws_launch_template.game.latest_version
      }
    }

  }
  tag {
    key                 = "Name"
    value               = "xwing-coop"
    propagate_at_launch = true
  }
}
resource "aws_iam_role" "deploy" {
  name = "xwing-coop-github"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Federated = var.github_oidc_provider_arn
        }, Action = "sts:AssumeRoleWithWebIdentity", Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:ref:refs/heads/${var.github_branch}"
        }
      }
    }]
  })
}
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["s3:PutObject"], Resource = "arn:aws:s3:::${var.artifact_bucket}/releases/*"
      },
      {
        Effect = "Allow", Action = ["ssm:SendCommand"], Resource = ["arn:aws:ssm:us-west-1::document/AWS-RunShellScript", "arn:aws:ec2:us-west-1:${data.aws_caller_identity.current.account_id}:instance/*"]
      },
      {
        Effect = "Allow", Action = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ec2:DescribeInstances"], Resource = "*"
      }
    ]
  })
}
output "ip" {
  value = aws_eip.game.public_ip
}
output "deploy_role" {
  value = aws_iam_role.deploy.arn
}
